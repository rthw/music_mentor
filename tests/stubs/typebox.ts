/** Заглушка typebox для тестов без установленных зависимостей: pi подставляет настоящий пакет сам. */
const obj = (type: string) => (opts: object = {}) => ({ type, ...opts });
export const Type = {
	String: obj("string"),
	Number: obj("number"),
	Boolean: obj("boolean"),
	Object: (properties: Record<string, unknown>, opts: object = {}) => ({ type: "object", properties, ...opts }),
	Array: (items: unknown, opts: object = {}) => ({ type: "array", items, ...opts }),
	Optional: (x: unknown) => x,
	Union: (anyOf: unknown[], opts: object = {}) => ({ anyOf, ...opts }),
};
