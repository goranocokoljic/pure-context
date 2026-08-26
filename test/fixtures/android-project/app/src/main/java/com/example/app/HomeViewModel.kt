package com.example.app

import androidx.lifecycle.ViewModel
import com.example.core.UserRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

@HiltViewModel
class HomeViewModel @Inject constructor(
    private val repository: UserRepository,
) : ViewModel() {
    fun greetingFor(userId: String): String {
        return "Hello, ${repository.userName(userId)}"
    }
}
