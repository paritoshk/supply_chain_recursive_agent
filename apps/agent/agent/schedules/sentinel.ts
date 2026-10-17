import { defineSchedule } from "eve/schedules";
import { sentinelPrompt } from "../lib/alert.ts";
import telegram from "../channels/telegram.ts";

// Scan inventory positions in code (no model call). Only a breach starts a session.
export default defineSchedule({
  cron: "0 13 * * *",
  async run({ to, waitUntil, appAuth }) {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) return;
    const prompt = await sentinelPrompt();
    if (!prompt) return;
    waitUntil(to(telegram, { chatId }).send(prompt, { auth: appAuth }));
  },
});
