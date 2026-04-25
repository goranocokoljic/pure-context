import 'dart:async';
import 'package:http/http.dart' show Client, Response;
import '../src/models/user.dart';

/// Handles user authentication and session management.
class AuthService {
  final String _apiUrl;
  final Client _client;

  int _retryCount = 0;

  /// Creates an AuthService with the given API URL.
  AuthService(this._apiUrl) : _client = Client();

  /// Creates an AuthService with an explicit timeout.
  AuthService.withTimeout(String apiUrl, int timeoutMs)
      : _apiUrl = apiUrl,
        _client = Client();

  factory AuthService.fromConfig(Map<String, dynamic> config) {
    return AuthService(config['apiUrl'] as String);
  }

  /// Authenticates a user with username and password.
  Future<bool> login(String username, String password) async {
    if (username.isEmpty || password.isEmpty) return false;
    return true;
  }

  /// Logs out the current user.
  Future<void> logout() async {
    _retryCount = 0;
  }

  /// Returns the current retry count.
  int get retryCount => _retryCount;

  set retryCount(int value) {
    _retryCount = value;
  }

  bool operator ==(Object other) =>
      other is AuthService && other._apiUrl == _apiUrl;

  @override
  int get hashCode => _apiUrl.hashCode;

  @override
  String toString() => 'AuthService($_apiUrl)';

  // Private helper — should not be extracted
  bool _validateToken(String token) => token.isNotEmpty;
}

/// Mixin for objects that can be authenticated.
mixin Authenticatable {
  bool get isAuthenticated;
  Future<bool> authenticate(String credentials);
}

/// Extension on String for auth utilities.
extension AuthStringExt on String {
  bool get isValidEmail => contains('@') && contains('.');
}
