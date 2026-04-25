import 'dart:convert';
import '../src/models/user.dart';

const String APP_VERSION = '1.0.0';
const int MAX_RETRIES = 3;
final String DEFAULT_LOCALE = 'en_US';

typedef UserMapper<T> = T Function(User user);

typedef JsonDecoder = dynamic Function(String json);

/// Formats a full name from parts.
String formatName(String first, String last) {
  return '$first $last';
}

/// Encodes an object to JSON string.
String toJson(Object obj) {
  return jsonEncode(obj);
}

/// Retries an async operation up to [maxRetries] times.
Future<T> withRetry<T>(Future<T> Function() operation, {int maxRetries = 3}) async {
  int attempts = 0;
  while (attempts < maxRetries) {
    try {
      return await operation();
    } catch (_) {
      attempts++;
      if (attempts >= maxRetries) rethrow;
    }
  }
  throw StateError('Unreachable');
}

// Private top-level function — should not be extracted
String _internalFormat(String s) => s.trim();
