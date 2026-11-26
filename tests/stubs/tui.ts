/**
 * Заглушка @earendil-works/pi-tui для тестов: pi в тестах не запускается, а рендеры проверяются
 * по тексту. Компонент Text хранит готовую строку, как настоящий, но с отступами не возится.
 */

export class Text {
	text: string;
	constructor(text = "", _padX = 0, _padY = 0) {
		this.text = text;
	}
	setText(text: string): void {
		this.text = text;
	}
	render(_width?: number): string[] {
		return this.text.split("\n");
	}
}

/** Ширина без управляющих последовательностей: в тестах они не встречаются. */
export function visibleWidth(s: string): number {
	return String(s).length;
}

/** Обрезка по ширине без переносов. */
export function truncateToWidth(s: string, width: number): string {
	const str = String(s);
	return str.length <= width ? str : str.slice(0, Math.max(0, width));
}

export class Container {
	children: any[] = [];
	addChild(c: any): void {
		this.children.push(c);
	}
	render(): string[] {
		return this.children.flatMap((c) => c.render?.() ?? []);
	}
}
