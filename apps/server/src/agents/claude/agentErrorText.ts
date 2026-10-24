/**
 * 已知 agent 故障特征 → 手机侧友好文案的映射表。
 *
 * 口径：**只映射可预知、有明确用户动作的错误**（内存不足/权限分组/认证/限流/网络/崩溃码/
 * 组件缺失——均来自真实反馈与联调踩坑）；未匹配时回退原文——不吞未知错误（原文对排障更有价值）。
 * 原始错误不丢失：调用方在映射前把原文写入服务端日志，`exit.stderrTail` 事件也保留原文。
 * 顺序即优先级（先命中先得）：内存类置顶——1455 的报文里常混有其他噪声，先于通用崩溃判定。
 */
const KNOWN_ERRORS: readonly { readonly pattern: RegExp; readonly friendly: string }[] = [
  {
    // Windows 提交内存耗尽（os error 1455 / 页面文件太小；2026-10-24 真实反馈）。
    pattern: /os error 1455|页面文件太小|paging file is too small|ERROR_COMMITMENT_LIMIT/i,
    friendly: "电脑内存不足，Claude 启动失败。请关闭部分程序（模拟器、浏览器等）后重试。",
  },
  {
    // 通用内存耗尽（含 Node/Bun heap 上限与 Windows 崩溃码——0xC0000409 栈溢出及其十进制形态）。
    pattern: /out of memory|heap out of memory|0xC0000409|3221226505|STATUS_STACK_BUFFER_OVERRUN|0xC00000FD|3221226045/i,
    friendly: "电脑内存不足或进程崩溃，Claude 未能完成。请关闭部分程序后重试。",
  },
  {
    // 中转站令牌分组限制（API 403；手机硬编码别名与实际分组不符时的典型形态）。
    pattern: /当前令牌无权访问所选分组|API Error: 403|Forbidden/i,
    friendly: "该模型无访问权限（API 令牌分组限制）。请切换其他模型，或在 API 控制台调整分组。",
  },
  {
    // 认证失败（令牌无效/过期）。
    pattern: /API Error: 401|authentication_error|invalid x-api-key|Unauthorized/i,
    friendly: "API 令牌无效或已过期，请在电脑端检查令牌配置。",
  },
  {
    // 限流/额度（429 与 plan 用尽）。
    pattern: /API Error: 429|rate.?limit|quota|额度已用尽|billing/i,
    friendly: "请求过于频繁或额度不足，请稍后重试。",
  },
  {
    // 服务端过载。
    pattern: /API Error: 529|overloaded/i,
    friendly: "模型服务暂时过载，请稍后重试。",
  },
  {
    // 网络/代理不可达（CLI 出站请求失败的一族）。
    pattern: /ECONNREFUSED|ETIMEDOUT|ECONNRESET|fetch failed|getaddrinfo|network error|self.?signed certificate/i,
    friendly: "网络连接失败，请检查电脑的网络或代理设置后重试。",
  },
  {
    // 可执行缺失/损坏（SDK 随包组件不可用）。
    pattern: /ENOENT|executable not found|CLI not found|Failed to start Claude Code/i,
    friendly: "电脑端 Claude 组件不可用，请重启 aimi 服务端后重试。",
  },
];

/**
 * 把 agent 原始错误文本映射为手机侧友好文案。
 * 命中已知特征返回友好文案（可直接展示）；未命中**原样返回**——未知错误的原文比任何
 * "通用失败提示"都更利于排障，不做兜底改写。
 *
 * @param raw - 原始错误文本（exit.stderrTail / 合成错误回复 / 控制请求失败原因）
 * @returns 可直接展示给用户的文案
 */
export function friendlyAgentError(raw: string): string {
  for (const known of KNOWN_ERRORS) {
    if (known.pattern.test(raw)) return known.friendly;
  }
  return raw;
}

/**
 * 是否命中已知错误特征（调用方据此决定"友好文案 vs 原文"的分支与日志级别）。
 *
 * @param raw - 原始错误文本
 * @returns true 表示 `friendlyAgentError` 会给出映射文案
 */
export function isKnownAgentError(raw: string): boolean {
  return KNOWN_ERRORS.some((known) => known.pattern.test(raw));
}
