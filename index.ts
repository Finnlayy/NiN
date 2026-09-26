import { generateText } from 'ai';

async function main(): Promise<void> {
  const result = await generateText({
    model: 'openai/gpt-5.5',
    prompt: 'Invent a new holiday and describe its traditions.',
  });

  console.log(result.text);
}

main();
