/**
 * Общие числа протокола заявок: клиент (lib/mm/wish.ts) и приёмник (tools/wish/wish_receiver.mjs) читают одно место.
 * Токен не секрет — он лежит в открытом пакете; защита приёмника — лимиты и проверка содержимого.
 */
export const proto = {
	url: "https://present.whimsical.work/api/wish",
	token: "mm-wish-1-7f3c9a2e5b814d60",
	maxBodyBytes: 4096,
	maxTextChars: 1500,
	minTextChars: 10,
	perIpPerDay: 5,
	globalPerDay: 60,
};
