import '../connection/aimi_connection.dart';

/// 服务端二维码载荷；token 不在二维码中出现。
class PairingPayload {
  const PairingPayload({
    required this.serverId,
    required this.lanUrl,
    required this.code,
    this.relayUrl,
    this.tlsFingerprint,
  });

  final String serverId;
  final String lanUrl;
  final String? relayUrl;
  final String? tlsFingerprint;
  final String code;

  factory PairingPayload.fromJson(Map<String, dynamic> json) {
    if (json['v'] != 1) throw const FormatException('二维码版本不支持');
    final serverId = json['serverId'];
    final lanUrl = json['lanUrl'];
    final code = json['code'];
    if (serverId is! String ||
        serverId.isEmpty ||
        lanUrl is! String ||
        lanUrl.isEmpty ||
        code is! String ||
        !RegExp(r'^\d{8}$').hasMatch(code)) {
      throw const FormatException('二维码字段无效');
    }
    final relay = json['relayUrl'];
    final fingerprint = json['tlsFingerprint'];
    if (relay != null && relay is! String) {
      throw const FormatException('relayUrl 无效');
    }
    if (fingerprint != null &&
        (fingerprint is! String ||
            !RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(fingerprint))) {
      throw const FormatException('tlsFingerprint 无效');
    }
    return PairingPayload(
      serverId: serverId,
      lanUrl: lanUrl,
      code: code,
      relayUrl: relay as String?,
      tlsFingerprint: fingerprint as String?,
    );
  }

  AimiEndpoints toEndpoints({required String token}) {
    final uri = Uri.parse(lanUrl);
    if (uri.host.isEmpty || uri.port <= 0) {
      throw const FormatException('lanUrl 无效');
    }
    return AimiEndpoints(
      host: uri.host,
      port: uri.port,
      token: token,
      scheme: uri.scheme,
      relayUrl: relayUrl,
      serverId: serverId,
      tlsFingerprint: tlsFingerprint,
      permissionModes: const [
        'default',
        'plan',
        'acceptEdits',
        'bypassPermissions',
      ],
    );
  }
}

/// TLS 信任决策，不执行 socket 操作，便于连接工厂单测。
class TlsTrustStore {
  String? _fingerprint;

  String? get fingerprint => _fingerprint;

  /// QR 指纹必须与当前证书一致；无 QR 指纹时首次连接采用 TOFU。
  bool verify(String actual, {String? qrFingerprint}) {
    if (qrFingerprint != null && !equals(actual, qrFingerprint)) return false;
    final trusted = _fingerprint;
    if (trusted == null) {
      _fingerprint = (qrFingerprint ?? actual).toLowerCase();
      return true;
    }
    return equals(trusted, actual);
  }

  void reset() => _fingerprint = null;

  static bool equals(String left, String right) =>
      left.replaceAll(':', '').toLowerCase() ==
      right.replaceAll(':', '').toLowerCase();
}
