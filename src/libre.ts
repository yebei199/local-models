// The LibreTranslate API that Dialect speaks, answered with Hy-MT2 prompts.

/** English and Chinese names, because Hy-MT2 wants the language named in the prompt's language. */
const LANGUAGES = {
  en: ['English', '英语'],
  ja: ['Japanese', '日语'],
  zh: ['Chinese', '中文'],
} as const;
type Code = keyof typeof LANGUAGES;
const CODES = Object.keys(LANGUAGES) as Code[];

/** Dialect cuts its input here. 3000 characters in and their translation out fit one 8192-token
 * llama-server slot; longer documents go through the `translate` command, which splits them. */
export const CHAR_LIMIT = 3000;

/** Hy-MT2's recommended sampling for the 7B model. */
const SAMPLING = {
  temperature: 0.7,
  top_p: 0.6,
  top_k: 20,
  repeat_penalty: 1.05,
  max_tokens: 4096,
};

const isCode = (value: unknown): value is Code => CODES.includes(value as Code);

/** Kana means Japanese, Han without kana Chinese, anything else English. Kanji-only Japanese such
 * as 手紙 reads as Chinese; that only mislabels the source, since the prompt names the target. */
export function detect(text: string): Code {
  if (/[぀-ヿ]/.test(text)) return 'ja';
  if (/\p{Script=Han}/u.test(text)) return 'zh';
  return 'en';
}

/** Hy-MT2's own templates: Chinese wording when Chinese is on either side, English otherwise. */
function prompt(text: string, source: Code, target: Code, html: boolean): string {
  if (source === 'zh' || target === 'zh') {
    const name = LANGUAGES[target][1];
    return html
      ? `# 任务目标\n将下方 HTML 格式数据翻译为${name}。\n\n# 严格约束\n1. 结构锁定：绝对保持原有的 HTML 数据结构、缩进和层级完全不变。\n2. 选择性翻译：仅翻译面向用户展示的可见文本内容。\n3. 禁止修改：严禁翻译或更改任何代码标签、属性或变量占位符。\n\n# 数据输入\n${text}`
      : `将以下文本翻译为${name}，注意只需要输出翻译后的结果，不要额外解释：\n\n${text}`;
  }
  const name = LANGUAGES[target][0];
  return html
    ? `### Task\nTranslate the user-facing text within the following HTML data into ${name}.\n\n### Strict Rules\n1. Structure Preservation: You MUST preserve the original HTML structure, nesting, hierarchy, and indentation exactly as they are.\n2. Selective Translation: Translate ONLY the visible, user-facing text content.\n3. Strict Non-Translation: NEVER translate or alter tags, attributes or placeholders.\n\n### Source Data\n${text}`
    : `Translate the following text into ${name}. Note that you should only output the translated result without any additional explanation:\n\n${text}`;
}

/** A LibreTranslate error: Dialect reads `error` and maps some wordings to its own messages. */
const failure = (message: string, status = 400) => Response.json({ error: message }, { status });

/** LibreTranslate takes JSON or a form; Dialect sends JSON to /translate and a form to /detect. */
async function fields(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.includes('application/json')) {
    const body: unknown = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  }
  return Object.fromEntries((await request.formData()).entries());
}

/** `q` is one text or a list; the answer mirrors whichever it was. */
function texts(q: unknown): string[] | undefined {
  if (typeof q === 'string') return [q];
  if (Array.isArray(q) && q.every((item) => typeof item === 'string')) return q;
  return undefined;
}

const languages = () => CODES.map((code) => ({ code, name: LANGUAGES[code][0], targets: CODES }));

/** A checked translation request. */
interface Job {
  items: string[];
  single: boolean;
  auto: boolean;
  sources: Code[];
  target: Code;
  html: boolean;
}

/** Validate a request the way LibreTranslate words its errors, which Dialect matches on. */
function job(body: Record<string, unknown>): Job | string {
  const items = texts(body.q);
  if (!items) return 'Invalid request: missing q parameter';
  const source = body.source ?? 'auto';
  if (source !== 'auto' && !isCode(source)) return `${source} is not supported`;
  if (!isCode(body.target)) return `${body.target} is not supported`;
  const longest = Math.max(...items.map((item) => item.length));
  if (longest > CHAR_LIMIT)
    return `Invalid request: request (${longest}) exceeds character limit (${CHAR_LIMIT})`;
  return {
    items,
    single: typeof body.q === 'string',
    auto: source === 'auto',
    sources: items.map((item) => (isCode(source) ? source : detect(item))),
    target: body.target,
    html: body.format === 'html',
  };
}

/** `complete` runs chat-completion bodies on the translator in one queue turn. */
export function libre(complete: (bodies: object[]) => Promise<string[]>) {
  async function translate(request: Request): Promise<Response> {
    const checked = job(await fields(request));
    if (typeof checked === 'string') return failure(checked);
    const { items, single, auto, sources, target, html } = checked;
    // Blank items need no model, and an empty prompt would make it invent text.
    const work = items.map((item, index) => ({ item, index })).filter(({ item }) => item.trim());
    let done: string[];
    try {
      done = await complete(
        work.map(({ item, index }) => ({
          messages: [{ role: 'user', content: prompt(item, sources[index] as Code, target, html) }],
          ...SAMPLING,
        })),
      );
    } catch (error) {
      return failure(String(error), 503);
    }
    const out = items.map(() => '');
    work.forEach(({ index }, at) => {
      out[index] = (done[at] ?? '').trim();
    });
    const detected = sources.map((language) => ({ confidence: 90, language }));
    return Response.json({
      translatedText: single ? out[0] : out,
      ...(auto ? { detectedLanguage: single ? detected[0] : detected } : {}),
    });
  }

  async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const route = `${request.method} ${path}`;
    if (route === 'GET /languages') return Response.json(languages());
    // Dialect checks the title to accept an instance URL, and reads the limits from settings.
    if (route === 'GET /spec') return Response.json({ info: { title: 'LibreTranslate' } });
    if (route === 'GET /frontend/settings')
      return Response.json({
        charLimit: CHAR_LIMIT,
        apiKeys: false,
        keyRequired: false,
        suggestions: false,
        language: { source: { code: 'auto' }, target: { code: 'zh' } },
      });
    if (route === 'POST /detect') {
      const items = texts((await fields(request)).q);
      if (!items) return failure('Invalid request: missing q parameter');
      return Response.json([{ confidence: 90, language: detect(items.join('\n')) }]);
    }
    if (route === 'POST /translate') return translate(request);
    return failure('Not found', 404);
  }

  return { handle };
}
