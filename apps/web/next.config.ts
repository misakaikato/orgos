import type { NextConfig } from "next";

const config: NextConfig = {
	// 浏览器只经服务端（8930）访问；Next 仅作内部 UI 进程（3930）。
	reactStrictMode: true,
	// @orgos/protocol 以 TS 源码发布（exports 指向 src/index.ts），需显式转译。
	transpilePackages: ["@orgos/protocol"],
	// 经 localhost / 127.0.0.1:8930 反代访问时放行 dev 资源与 HMR，否则页面不水合。
	allowedDevOrigins: ["127.0.0.1", "localhost"],
	// 不让 next dev 往仓库里写 AGENTS.md / CLAUDE.md。
	agentRules: false,
	// 开发角标会盖住导航轨底部的本人头像。
	devIndicators: false,
};

export default config;
