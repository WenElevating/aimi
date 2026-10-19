import 'package:aimi/data/pairing/pairing_payload.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('QR payload parses and preserves optional relay/fingerprint', () {
    final payload = PairingPayload.fromJson({
      'v': 1,
      'serverId': 'srv-1',
      'lanUrl': 'wss://192.168.1.2:8787/ws',
      'relayUrl': 'wss://relay/device?srv=srv-1',
      'tlsFingerprint': 'a' * 64,
      'code': '12345678',
    });
    final endpoints = payload.toEndpoints(token: 'token-value');
    expect(endpoints.host, '192.168.1.2');
    expect(endpoints.scheme, 'wss');
    expect(
      endpoints.relayUri,
      Uri.parse('wss://relay/device?srv=srv-1&serverId=srv-1'),
    );
  });

  test('invalid QR payload is rejected', () {
    expect(() => PairingPayload.fromJson({'v': 1}), throwsFormatException);
    expect(
      () => PairingPayload.fromJson({
        'v': 1,
        'serverId': 's',
        'lanUrl': 'ws://x:1',
        'code': 'bad',
      }),
      throwsFormatException,
    );
  });

  test('TLS QR pin and manual TOFU reject later replacement', () {
    final store = TlsTrustStore();
    expect(store.verify('AA:bb', qrFingerprint: 'aabb'), isTrue);
    expect(store.verify('aabb'), isTrue);
    expect(store.verify('ccdd'), isFalse);
    store.reset();
    expect(store.verify('ccdd'), isTrue);
  });

  test(
    'TLS QR pin mismatch does not establish or replace the existing trust',
    () {
      final store = TlsTrustStore();
      expect(store.verify('aa:bb', qrFingerprint: 'ccdd'), isFalse);
      expect(store.fingerprint, isNull);
      expect(store.verify('aa:bb', qrFingerprint: 'aabb'), isTrue);
      expect(store.verify('eeff', qrFingerprint: 'eeff'), isFalse);
      expect(store.fingerprint, 'aabb');
    },
  );
}
