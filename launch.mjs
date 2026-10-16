import { spawn } from "node:child_process";
const url = "http://127.0.0.1:4317";
async function alreadyRunning() {
  try {
    const res = await fetch(`${url}/api/state`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok && (await res.json()).appId === "kazak-studio";
  } catch {
    return false;
  }
}
function show() {
  spawn("/usr/bin/open", [url], { stdio: "ignore" }).on("error", () =>
    console.log(`Откройте ${url}`),
  );
}
if (await alreadyRunning()) {
  show();
  console.log("KAZAK studio уже работает.");
} else {
  try {
    const { createStudio } = await import("./server.mjs");
    const studio = createStudio();
    studio.server.listen(4317, "127.0.0.1", () => {
      console.log(
        `KAZAK studio · ${url}\nЧтобы закрыть сервер, нажмите Ctrl+C в этом окне.`,
      );
      show();
    });
    studio.server.on("error", (e) => {
      console.error(
        e.code === "EADDRINUSE"
          ? "Порт 4317 занят другим приложением. Освободите порт и повторите запуск."
          : e.message,
      );
      studio.close();
      process.exitCode = 1;
    });
    const stop = () => {
      console.log(
        "Студия закрыта. Задания провайдера продолжат выполняться; откройте студию, чтобы получить результаты.",
      );
      studio.close();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (e) {
    console.error(
      `KAZAK studio не удалось запустить: ${e.message}\nОткройте README.md в папке студии. Сохранённые фильмы находятся в Library/Application Support/KAZAK studio API/data.`,
    );
    process.exitCode = 1;
  }
}
