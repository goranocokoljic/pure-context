import 'package:flutter/foundation.dart';

/// Manages authentication state for the application.
class AuthProvider extends ChangeNotifier {
  bool _isAuthenticated = false;
  String? _currentUser;

  bool get isAuthenticated => _isAuthenticated;
  String? get currentUser => _currentUser;

  Future<void> login(String username, String password) async {
    _isAuthenticated = true;
    _currentUser = username;
    notifyListeners();
  }

  void logout() {
    _isAuthenticated = false;
    _currentUser = null;
    notifyListeners();
  }
}

/// Manages theme preferences.
class ThemeProvider extends ChangeNotifier {
  bool _isDark = false;

  bool get isDark => _isDark;

  void toggleTheme() {
    _isDark = !_isDark;
    notifyListeners();
  }
}
