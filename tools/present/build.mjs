#!/usr/bin/env node
// Собирает страницу-открытку present.whimsical.work.
// Установочный .cmd (с ключом DeepSeek друга) шифруется паролем: PBKDF2-SHA256 + AES-GCM, в браузере
// расшифровывается WebCrypto. Ключ в открытом виде в страницу не попадает. Готовая страница — вне репо.
//   secret run deepseek_music_mentor present_password -- node tools/present/build.mjs <тег> <папка-выхода>
// Пароль — только из хранилища `secret` (present_password): репо публичный, в коде его быть не должно.
import { webcrypto as crypto } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [tag, outDir] = process.argv.slice(2);
if (!tag || !outDir) {
	console.error("usage: build.mjs <тег> <папка-выхода>");
	process.exit(2);
}
const key = (process.env.deepseek_music_mentor || "").trim();
if (!key) {
	console.error("build: ключ пуст (запускать под `secret run deepseek_music_mentor --`)");
	process.exit(1);
}
const passwords = (process.env.present_password || "")
	.split("|")
	.map((s) => s.trim())
	.filter(Boolean);
if (!passwords.length) {
	console.error("build: пароль пуст (secret set present_password; несколько вариантов — через |)");
	process.exit(1);
}

const url = `https://raw.githubusercontent.com/rthw/music_mentor/${tag}/install.ps1`;
// Только ASCII: cmd.exe читает файл в OEM-кодировке.
const cmd = [
	"@echo off",
	"title Music mentor setup",
	`powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:MM_KEY='${key}'; $env:MM_TAG='${tag}'; irm ${url} | iex"`,
	"echo.",
	"pause",
	"",
].join("\r\n");

const ITER = 600_000;
const enc = new TextEncoder();
const b64 = (u8) => Buffer.from(u8).toString("base64");

async function seal(password) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const base = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
	const k = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, enc.encode(cmd)));
	return { s: b64(salt), i: b64(iv), c: b64(ct) };
}

const boxes = [];
for (const p of passwords) boxes.push(await seal(p));
const here = path.dirname(new URL(import.meta.url).pathname);
const html = readFileSync(path.join(here, "index.html"), "utf8").replace(
	"/*__SEALED__*/null",
	JSON.stringify({ iter: ITER, boxes }),
);
if (html.includes(key) || passwords.some((p) => html.includes(p))) throw new Error("ключ или пароль в открытом виде попал в страницу");
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "index.html"), html);
console.log(`build: ${path.join(outDir, "index.html")} (тег ${tag}, паролей ${boxes.length})`);
