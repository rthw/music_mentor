/**
 * Минимальный разборщик XML для файлов Ableton (.als после gunzip).
 * Нужен только набор возможностей, который есть в .als: элементы, атрибуты, самозакрывающиеся теги,
 * объявление и комментарии. Зависимостей нет, чтобы пакет ставился без npm install.
 */

export interface XmlNode {
	tag: string;
	attrs: Record<string, string>;
	children: XmlNode[];
	text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function unescapeXml(s: string): string {
	if (!s.includes("&")) return s;
	return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
		if (e[0] === "#") {
			const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : m;
		}
		return ENTITIES[e] ?? m;
	});
}

export function parseXml(src: string): XmlNode {
	const root: XmlNode = { tag: "#document", attrs: {}, children: [], text: "" };
	const stack: XmlNode[] = [root];
	// тег: <name attrs/>, </name>, <?...?>, <!--...-->, <![CDATA[...]]>
	const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
	const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src))) {
		const top = stack[stack.length - 1];
		if (m[1] !== undefined) top.text += m[1];
		else if (m[2] !== undefined) {
			if (stack.length < 2 || top.tag !== m[2]) throw new Error(`XML: лишний закрывающий тег </${m[2]}> (открыт <${top.tag}>)`);
			stack.pop();
		} else if (m[3] !== undefined) {
			const attrs: Record<string, string> = {};
			let a: RegExpExecArray | null;
			attrRe.lastIndex = 0;
			while ((a = attrRe.exec(m[4] ?? ""))) attrs[a[1]] = unescapeXml(a[2] ?? a[3] ?? "");
			const node: XmlNode = { tag: m[3], attrs, children: [], text: "" };
			top.children.push(node);
			if (m[5] !== "/") stack.push(node);
		} else if (m[6] !== undefined) {
			const t = m[6].trim();
			if (t) top.text += unescapeXml(t);
		}
	}
	if (stack.length !== 1) throw new Error(`XML: не закрыт тег <${stack[stack.length - 1].tag}>`);
	const first = root.children[0];
	if (!first) throw new Error("XML: пустой документ");
	return first;
}

export function child(n: XmlNode | undefined, tag: string): XmlNode | undefined {
	return n?.children.find((c) => c.tag === tag);
}

/** Путь из тегов через «/»: find(n, "Mixer/Tempo/Manual"). */
export function find(n: XmlNode | undefined, path: string): XmlNode | undefined {
	let cur = n;
	for (const part of path.split("/")) {
		cur = child(cur, part);
		if (!cur) return undefined;
	}
	return cur;
}

/** Атрибут Value у вложенного элемента: val(n, "Name/EffectiveName"). */
export function val(n: XmlNode | undefined, path: string): string | undefined {
	return find(n, path)?.attrs.Value;
}

export function num(n: XmlNode | undefined, path: string, fallback = 0): number {
	const v = val(n, path);
	const x = v === undefined ? NaN : Number(v);
	return Number.isFinite(x) ? x : fallback;
}

export function bool(n: XmlNode | undefined, path: string, fallback = false): boolean {
	const v = val(n, path);
	return v === undefined ? fallback : v === "true";
}
