import { createReadStream } from "node:fs";
import { access, copyFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const pagePath = join(currentDirectory, "current.html");
const initialPagePath = join(currentDirectory, "states", "closed.html");
const host = process.env.DEMO_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.DEMO_PORT ?? "3001");

try {
  await access(pagePath);
} catch {
  await copyFile(initialPagePath, pagePath);
}


const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (request.url !== "/" && request.url !== "/index.html") {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
  });
  createReadStream(pagePath).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Conference page is available at http://${host}:${port}/`);
});
