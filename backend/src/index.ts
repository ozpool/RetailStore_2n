import "dotenv/config";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { authRouter } from "./routes/auth";
import { catalogRouter } from "./routes/catalog";
import { assertMailConfigured } from "./lib/mailer";

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";

app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));

app.use(express.json());
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "retailstore-2n-backend" });
});

app.use("/auth", authRouter);
app.use("/catalog", catalogRouter);
let mailSummary: string;
try {
  mailSummary = assertMailConfigured();
} catch (err) {
  console.error(`\nConfiguration error:\n  ${(err as Error).message}\n`);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`RetailStore_2n backend listening on http://localhost:${PORT}`);
  console.log(`Email:    ${mailSummary}`);
});
