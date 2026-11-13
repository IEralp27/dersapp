// Küçük XML ayrıştırıcı: PPTX parçaları (iyi biçimli OOXML) için yeterli.
// DOMParser yerine kendi ayrıştırıcımız: hem tarayıcıda hem Node testlerinde aynı kod çalışır.

export interface XNode {
  /** Önek dahil ad, ör. "a:p" */
  name: string;
  attrs: Record<string, string>;
  kids: XNode[];
  /** Doğrudan içerdiği metin (yalnızca a:t gibi yapraklarda anlamlı) */
  text: string;
}

const ENT: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e] ?? m;
  });
}

const ATTR_RE = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

export function parseXml(src: string): XNode {
  const root: XNode = { name: "#root", attrs: {}, kids: [], text: "" };
  const stack: XNode[] = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) stack[stack.length - 1].text += decodeEntities(src.slice(i, lt));
    if (src.startsWith("<?", lt)) {
      i = src.indexOf("?>", lt) + 2;
      continue;
    }
    if (src.startsWith("<!--", lt)) {
      i = src.indexOf("-->", lt) + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt);
      stack[stack.length - 1].text += src.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (src.startsWith("<!", lt)) {
      i = src.indexOf(">", lt) + 1;
      continue;
    }
    const gt = src.indexOf(">", lt);
    if (gt < 0) break;
    if (src[lt + 1] === "/") {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }
    const selfClose = src[gt - 1] === "/";
    const body = src.slice(lt + 1, selfClose ? gt - 1 : gt);
    const sp = body.search(/\s/);
    const name = sp < 0 ? body : body.slice(0, sp);
    const attrs: Record<string, string> = {};
    if (sp >= 0) {
      ATTR_RE.lastIndex = 0;
      const rest = body.slice(sp);
      let m: RegExpExecArray | null;
      while ((m = ATTR_RE.exec(rest))) attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? "");
    }
    const node: XNode = { name, attrs, kids: [], text: "" };
    stack[stack.length - 1].kids.push(node);
    if (!selfClose) stack.push(node);
    i = gt + 1;
  }
  return root.kids.find((k) => k.name !== "#text") ?? root;
}

/** Önekten bağımsız ad: "p:sp" -> "sp" */
export function local(name: string): string {
  const c = name.indexOf(":");
  return c < 0 ? name : name.slice(c + 1);
}

/** İlk doğrudan çocuk (önekten bağımsız ad). Yol: "spPr/xfrm/off". */
export function child(node: XNode | null | undefined, path: string): XNode | null {
  let cur: XNode | null | undefined = node;
  for (const part of path.split("/")) {
    if (!cur) return null;
    cur = cur.kids.find((k) => local(k.name) === part);
  }
  return cur ?? null;
}

export function children(node: XNode | null | undefined, name: string): XNode[] {
  return node ? node.kids.filter((k) => local(k.name) === name) : [];
}

export function attr(node: XNode | null | undefined, name: string): string | undefined {
  return node?.attrs[name];
}

export function numAttr(node: XNode | null | undefined, name: string): number | undefined {
  const v = node?.attrs[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Alt ağaçtaki tüm `name` düğümleri (derinlik öncelikli). */
export function descendants(node: XNode | null | undefined, name: string, out: XNode[] = []): XNode[] {
  if (!node) return out;
  for (const k of node.kids) {
    if (local(k.name) === name) out.push(k);
    descendants(k, name, out);
  }
  return out;
}
