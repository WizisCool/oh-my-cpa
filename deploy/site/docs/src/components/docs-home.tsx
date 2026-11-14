import type * as PageTree from 'fumadocs-core/page-tree';
import Link from 'fumadocs-core/link';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import { ArrowRight, Bot, Boxes, PlayCircle, Rocket, Server } from 'lucide-react';
import type { SVGProps } from 'react';
import { source } from '@/lib/source';
import { AGENT_PROMPT, GITHUB_URL, type Lang } from '@/lib/site';

function Github(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

const TEXT = {
  en: {
    title: 'Oh My CPA documentation',
    lead: 'Install the console, keep it running, and make the most of it. Start with the path that fits you.',
    paths: [
      {
        icon: Rocket,
        title: 'Starting fresh',
        body: 'Run the gateway, the console and the updater together. Four commands, about three minutes.',
        href: '/en/start/quickstart',
        cta: 'Quickstart',
      },
      {
        icon: Server,
        title: 'Already running CLIProxyAPI',
        body: 'Add the console beside your gateway. Its configuration, keys and port stay as they are.',
        href: '/en/install',
        cta: 'Choose an install path',
      },
    ],
    agent: {
      title: 'Let a coding agent install it',
      body: 'Paste this into Claude Code, Codex or Cursor. The agent checks your host, asks before anything it cannot undo, and reports the console address.',
      more: 'What the agent does',
      href: '/en/start/agent',
    },
    browse: 'Browse by topic',
    beyond: 'Beyond the docs',
    elsewhere: [
      { icon: PlayCircle, title: 'Live demo', body: 'The real console on sample data, in your browser.', href: '/demo/' },
      { icon: Boxes, title: 'API reference', body: 'Every console endpoint, with request and response schemas.', href: '/api-reference/' },
      { icon: Github, title: 'GitHub', body: 'Source, releases and issues.', href: GITHUB_URL },
    ],
  },
  zh: {
    title: 'Oh My CPA 文档',
    lead: '安装控制台、保持稳定运行并充分用好它。从最适合你的路径开始。',
    paths: [
      {
        icon: Rocket,
        title: '从零开始',
        body: '一次运行网关、控制台与更新器。四条命令，约三分钟。',
        href: '/zh/start/quickstart',
        cta: '快速开始',
      },
      {
        icon: Server,
        title: '已在运行 CLIProxyAPI',
        body: '在现有网关旁加装控制台，网关的配置、密钥与端口保持原样。',
        href: '/zh/install',
        cta: '选择安装方式',
      },
    ],
    agent: {
      title: '让编码 Agent 替你安装',
      body: '把这句话粘贴给 Claude Code、Codex 或 Cursor。Agent 会先检查主机，在不可撤销的操作前征求同意，完成后告诉你控制台地址。',
      more: 'Agent 会做什么',
      href: '/zh/start/agent',
    },
    browse: '按主题浏览',
    beyond: '文档之外',
    elsewhere: [
      { icon: PlayCircle, title: '在线演示', body: '在浏览器中体验使用示例数据的真实控制台。', href: '/demo/' },
      { icon: Boxes, title: 'API 参考', body: '控制台全部接口及其请求与响应结构。', href: '/api-reference/' },
      { icon: Github, title: 'GitHub', body: '源码、版本发布与问题反馈。', href: GITHUB_URL },
    ],
  },
} as const;

function TopicCard({ folder, lang }: { folder: PageTree.Folder; lang: Lang }) {
  const first = folder.children.find((child): child is PageTree.Item => child.type === 'page' && !child.external);
  const href = folder.index?.url ?? first?.url;
  const description = source.getNodeMeta(folder, lang)?.data.description;

  return <Card icon={folder.icon} title={folder.name} description={description} href={href} />;
}

export function DocsHome({ lang }: { lang: Lang }) {
  const text = TEXT[lang];
  const tree = source.getPageTree(lang);
  const folders = tree.children.filter((node): node is PageTree.Folder => node.type === 'folder');

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-14 pt-4 pb-16">
      <header className="flex max-w-2xl flex-col gap-3">
        <h1 className="text-3xl font-semibold">{text.title}</h1>
        <p className="text-fd-muted-foreground">{text.lead}</p>
      </header>

      <section className="flex flex-col gap-3">
        <Cards>
          {text.paths.map((path) => (
            <Card key={path.href} icon={<path.icon />} title={path.title} description={path.body} href={path.href}>
              <span className="inline-flex items-center gap-1 pt-3 font-medium text-fd-primary">
                {path.cta}
                <ArrowRight className="size-3.5" aria-hidden />
              </span>
            </Card>
          ))}
        </Cards>
        <Card icon={<Bot />} title={text.agent.title} description={text.agent.body}>
          {/* The card body strips its first child's top margin, so spacing comes from padding and gap. */}
          <div className="flex flex-col items-start gap-3 pt-3">
            <CodeBlock className="my-0 self-stretch">
              <Pre>
                <code>
                  <span className="line">{AGENT_PROMPT[lang]}</span>
                </code>
              </Pre>
            </CodeBlock>
            <Link href={text.agent.href} className="inline-flex items-center gap-1 font-medium text-fd-primary">
              {text.agent.more}
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </div>
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">{text.browse}</h2>
        <Cards className="lg:grid-cols-3">
          {folders.map((folder) => (
            <TopicCard key={folder.$id ?? String(folder.name)} folder={folder} lang={lang} />
          ))}
        </Cards>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">{text.beyond}</h2>
        <Cards className="lg:grid-cols-3">
          {text.elsewhere.map((item) => (
            <Card
              key={item.href}
              icon={<item.icon />}
              title={item.title}
              description={item.body}
              href={item.href}
              external={item.href.startsWith('http')}
            />
          ))}
        </Cards>
      </section>
    </div>
  );
}
