import type { Metadata } from "next";
import "./style.css";

export const metadata: Metadata = { title: "个人 Agent 工作台", description: "本地学习与生活 Agent 工作台" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
