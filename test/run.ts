/**
 * Общий гейт `npm test`: все тесты по порядку. Раньше e2e жили отдельными
 * скриптами и в гейт не входили — CI/локальный прогон их не видел.
 * Запускать через jiti (репозиторий без сборки).
 */
await import("./selfcheck.ts");
await import("./e2e.ts");
await import("./e2e-slices.ts");

// смоук: индекс грузится и регистрирует инструменты (фейковый pi-хост)
const { default: commander } = await import("../index.ts");
commander({ registerTool() {}, on() {} } as never);
console.log("index loads + registers OK");
