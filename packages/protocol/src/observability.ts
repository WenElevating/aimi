import { z } from "zod";

/** 指标目录只允许技术标识，不提供任意标签或正文入口。 */
const metricName = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9_.]*$/);
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.:/@+ -]+$/);
const label = z.string().min(1).max(160);

/** 指标契约描述测量边界；不可用与数值零必须分开。 */
export const metricDescriptorSchema = z
  .object({
    name: metricName,
    kind: z.enum(["counter", "gauge", "histogram", "span"]),
    unit: z.enum(["ms", "count", "bytes", "utf16", "px"]),
    description: label,
    boundary: label,
    availability: z.enum(["available", "unsupported"]),
    reason: label.optional(),
  })
  .strict();

/** 白名单维度用于关联阶段，不接受动态标签、路径或用户文本。 */
export const metricContextSchema = z
  .object({
    sessionId: identifier.optional(),
    turnStartSeq: z.number().int().nonnegative().optional(),
    seq: z.number().int().nonnegative().optional(),
    seqEnd: z.number().int().nonnegative().optional(),
    agentId: identifier.optional(),
    model: identifier.optional(),
    appVersion: identifier.optional(),
    buildMode: z.enum(["debug", "profile", "release", "test"]).optional(),
    deviceModel: identifier.optional(),
    refreshRate: z.number().positive().max(1000).optional(),
    renderer: identifier.optional(),
    scenario: identifier.optional(),
  })
  .strict();

/** 来源实例在进程重启后重新生成，序号仅在该实例内递增。 */
export const metricSourceSchema = z
  .object({
    instanceId: identifier,
    sourceId: identifier,
    component: z.enum(["agent", "server", "client"]),
  })
  .strict();

/** 明细状态为固定枚举，禁止把错误堆栈或正文充当 detail。 */
export const metricRecordSchema = z
  .object({
    sequence: z.number().int().positive(),
    name: metricName,
    value: z.number().finite().nonnegative(),
    ts: z.number().int().nonnegative(),
    monoMs: z.number().finite().nonnegative(),
    context: metricContextSchema,
    detail: z
      .enum(["ok", "error", "cancelled", "timeout", "interrupted", "completed", "replay", "background", "foreground"])
      .optional(),
  })
  .strict();

/** 每批大小固定有界，目录定义随批次发送以支持客户端重新连接。 */
export const metricBatchSchema = z
  .object({
    source: metricSourceSchema,
    descriptors: z.array(metricDescriptorSchema).max(128),
    records: z.array(metricRecordSchema).max(128),
    dropped: z.number().int().nonnegative(),
    closed: z.boolean(),
  })
  .strict()
  .superRefine((batch, ctx) => {
    const names = new Set(batch.descriptors.map((descriptor) => descriptor.name));
    if (names.size !== batch.descriptors.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate metric descriptor" });
    }
    let sequence = 0;
    for (const record of batch.records) {
      if (!names.has(record.name) || record.sequence <= sequence) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "undeclared metric or unordered sequence" });
      }
      sequence = record.sequence;
    }
  });

export type MetricDescriptor = z.infer<typeof metricDescriptorSchema>;
export type MetricContext = z.infer<typeof metricContextSchema>;
export type MetricSource = z.infer<typeof metricSourceSchema>;
export type MetricRecord = z.infer<typeof metricRecordSchema>;
export type MetricBatch = z.infer<typeof metricBatchSchema>;

/** 游标读取无破坏性；只有持久化确认后采集器才推进游标。 */
export interface MetricsReadRequest {
  readonly afterSequence: number;
  readonly limit: number;
}

/** 返回批次与已读边界，空批也能携带目录和来源状态。 */
export interface MetricsReadResult {
  readonly batch: MetricBatch;
  readonly nextSequence: number;
}

/** 适配器和服务组件共同实现的观测面，不暴露 CLI/SDK 内部对象。 */
export interface MetricsProvider {
  readonly source: MetricSource;
  describeMetrics(): readonly MetricDescriptor[];
  readMetrics(request: MetricsReadRequest): Promise<MetricsReadResult>;
}
