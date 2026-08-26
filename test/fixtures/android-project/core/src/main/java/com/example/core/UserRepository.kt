package com.example.core

import javax.inject.Inject

interface UserRepository {
    fun userName(userId: String): String
}

class UserRepositoryImpl @Inject constructor(
    private val database: AppDatabase,
) : UserRepository {
    override fun userName(userId: String): String {
        return database.lookupName(userId)
    }
}
