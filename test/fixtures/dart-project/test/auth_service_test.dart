import 'package:test/test.dart';
import '../lib/src/auth_service.dart';

void main() {
  group('AuthService', () {
    late AuthService service;

    setUp(() {
      service = AuthService('https://api.example.com');
    });

    test('login returns false for empty credentials', () async {
      final result = await service.login('', '');
      expect(result, isFalse);
    });
  });
}
