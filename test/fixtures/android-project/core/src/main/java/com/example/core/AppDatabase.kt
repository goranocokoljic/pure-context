package com.example.core

class AppDatabase {
    fun lookupName(userId: String): String {
        return "user-$userId"
    }

    fun insertEvent(name: String) {
        // no-op fixture
    }
}
