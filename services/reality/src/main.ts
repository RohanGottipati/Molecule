import { app } from "./server.js";

try {
  await app.listen({
    port: Number(process.env.REALITY_PORT ?? 3002),
    host: "0.0.0.0",
  });
} catch {
  console.error("Reality server failed to start");
  process.exitCode = 1;
}
