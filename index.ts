import { generateText } from 'ai';

async function main(): Promise<void> {
  const result = await generateText({
    model: 'openai/gpt-4o-mini',
    prompt: 'Invent a new holiday and describe its traditions.',
  });

  console.log(result.text);
}

main();
