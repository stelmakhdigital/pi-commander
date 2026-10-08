/**
 * Шаблоны инициализации проекта: каждая директория templates/<name>/ в корне
 * пакета — отдельный шаблон. Новый шаблон = новая директория, код не трогаем.
 * applyTemplate копирует все файлы шаблона в корень проекта; проект считается
 * уже инициализированным, если в нём есть task.md (тогда копирование запрещено).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Корень каталога шаблонов (рядом с этим файлом, в корне пакета). */
export const TEMPLATES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "templates");

/** Имена доступных шаблонов (поддиректории templates/), отсортированные. */
export const listTemplates = (): string[] =>
	fs.existsSync(TEMPLATES_DIR)
		? fs
				.readdirSync(TEMPLATES_DIR, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name)
				.sort()
		: [];

/**
 * Скопировать все файлы templates/<name>/ в targetDir (включая поддиректории).
 * Бросает ошибку, если: имя недопустимо, шаблон не найден, target не каталог,
 * в target уже есть task.md (проект уже инициализирован — поверх не пишем).
 * Возвращает список скопированных файлов (относительные пути от targetDir).
 */
export function applyTemplate(name: string, targetDir: string): { copied: string[] } {
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0"))
		throw new Error(`недопустимое имя шаблона «${name}» (только имя директории в templates/)`);
	const src = path.join(TEMPLATES_DIR, name);
	if (!fs.existsSync(src) || !fs.statSync(src).isDirectory())
		throw new Error(`шаблон «${name}» не найден (доступно: ${listTemplates().join(", ") || "—"})`);
	if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory())
		throw new Error(`каталог проекта ${targetDir} не найден`);
	if (fs.existsSync(path.join(targetDir, "task.md")))
		throw new Error(`в проекте уже есть task.md — он считается инициализированным, шаблон поверх не применяется`);

	const copied: string[] = [];
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const s = path.join(dir, e.name);
			if (e.isDirectory()) walk(s);
			else if (e.isFile()) {
				const rel = path.relative(src, s);
				const dest = path.join(targetDir, rel);
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				fs.copyFileSync(s, dest);
				copied.push(rel);
			}
		}
	};
	walk(src);
	return { copied: copied.sort() };
}
