import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

export const codeGenerateSchema = z.object({
  path: z.string(),
  content: z.string(),
  overwrite: z.boolean().default(false)
});

export async function code_generate(input: z.infer<typeof codeGenerateSchema>) {
  const dest = path.resolve(input.path);
  try {
    await fs.access(dest);
    if (!input.overwrite) {
      return { content: [{ type: "text", text: `File exists: ${dest}` }] };
    }
  } catch {
    // ok
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, input.content, "utf8");
  return { content: [{ type: "text", text: `Generated ${dest}` }] };
}