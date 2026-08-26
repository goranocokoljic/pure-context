package com.example.app

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import androidx.hilt.navigation.compose.hiltViewModel

@Composable
fun HomeScreen(viewModel: HomeViewModel = hiltViewModel()) {
    Column {
        Text(text = "Hello from the fixture")
        GreetingRow(name = "fixture")
    }
}

@Composable
fun GreetingRow(name: String) {
    Text(text = "Hello, $name")
}

@Preview(showBackground = true)
@Composable
fun HomeScreenPreview() {
    HomeScreen()
}

fun formatTitle(raw: String): String {
    return raw.trim()
}
