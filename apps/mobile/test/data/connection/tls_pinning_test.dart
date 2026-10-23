import 'dart:io';
import 'dart:typed_data';

import 'package:aimi/data/connection/tls_pinning.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';

/// 固定 DER 内容的证书假体：指纹比对只读 [der]，其余成员不触达。
class FakeCert implements X509Certificate {
  FakeCert(List<int> bytes) : der = Uint8List.fromList(bytes);

  @override
  final Uint8List der;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  test('指纹匹配：DER 的 sha256 小写 hex 与预期一致才放行', () {
    final der = [1, 2, 3, 4, 5];
    final digest = sha256.convert(der).toString();
    expect(certMatchesFingerprint(FakeCert(der), digest), isTrue);
  });

  test('大小写与冒号分隔归一后放行（与服务端展示形态解耦）', () {
    final der = [1, 2, 3, 4, 5];
    final digest = sha256.convert(der).toString();
    final buffer = StringBuffer();
    for (var i = 0; i < digest.length; i++) {
      if (i > 0 && i % 2 == 0) buffer.write(':');
      buffer.write(digest[i].toUpperCase());
    }
    expect(buffer.toString().contains(':'), isTrue);
    expect(certMatchesFingerprint(FakeCert(der), buffer.toString()), isTrue);
  });

  test('指纹不匹配、非法长度一律拒绝', () {
    final der = [9, 9, 9];
    expect(certMatchesFingerprint(FakeCert(der), 'a' * 64), isFalse);
    expect(certMatchesFingerprint(FakeCert(der), 'short'), isFalse);
    expect(certMatchesFingerprint(FakeCert(der), ''), isFalse);
  });
}
