/**
 * aimi-server 版本号单一来源（§5.2 app/ 独家持有装配常量）。
 * `welcome.serverVersion`、`ServerConfig.serverVersion` 默认值、CLI 输出均取此处，
 * 避免三处各写一个字面量漂移。
 */
export const SERVER_VERSION = "0.1.0";
