import axios from 'axios';

const SWFTE_API = 'https://api.swfte.com/agents';

/** Server-side proxy for the help widget, so the widget key never ships to the page. */
export async function askHelpWidget(question: string, visitor: string): Promise<string> {
  const { data } = await axios.post<{ content?: string }>(`${SWFTE_API}/v1/widgets/wg_Help4M/public/invoke`, {
    question,
    visitor,
  });
  return data.content ?? '';
}
