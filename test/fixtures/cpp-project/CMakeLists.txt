cmake_minimum_required(VERSION 3.16)
project(cpp_fixture CXX)

set(CMAKE_CXX_STANDARD 17)

add_library(auth src/auth.cpp)
target_include_directories(auth PUBLIC include)

add_library(utils src/utils.cpp)
target_include_directories(utils PUBLIC include)
