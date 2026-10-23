// adbkit-apkreader 无官方类型；此处只声明发布 CLI 用到的最小面（open + readManifest）。
// 解析结果字段按 AndroidManifest 实际取值声明为可选——版本字段缺失由调用方显式校验。
declare module "adbkit-apkreader" {
  interface ApkManifest {
    versionName?: string;
    versionCode?: number;
    packageName?: string;
  }

  const ApkReader: {
    open(path: string): Promise<{ readManifest(): Promise<ApkManifest> }>;
  };

  export default ApkReader;
}
