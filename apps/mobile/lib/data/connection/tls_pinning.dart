import 'dart:io';

import 'package:crypto/crypto.dart';

/// 判断对端证书是否匹配预期指纹（TOFU 信任锚）。
///
/// 指纹口径与服务端 `tlsFingerprintOf` 一致：证书 DER 编码的 SHA-256、小写 hex、无冒号。
/// 只用于自签场景的「证书不受系统信任时的比对放行」——系统信任链正常的证书
/// 不会走到这里（badCertificateCallback 只在默认校验失败时触发）。
bool certMatchesFingerprint(X509Certificate cert, String expectedFingerprint) {
  final expected = expectedFingerprint.trim().toLowerCase().replaceAll(':', '');
  if (expected.length != 64) return false;
  return sha256.convert(cert.der).toString() == expected;
}
