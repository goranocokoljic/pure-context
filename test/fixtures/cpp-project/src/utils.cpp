#include <string>
#include <algorithm>
#include <sstream>

// String utility macros.
#define TRIM_WHITESPACE(s) (s)
#define MAX_STRING_LEN     4096

namespace Utils {

using StringList = std::vector<std::string>;
using ErrorCode  = int;

/// Trim whitespace from both ends of a string.
std::string trim(const std::string& s) {
    size_t start = s.find_first_not_of(" \t\n\r");
    size_t end   = s.find_last_not_of(" \t\n\r");
    return (start == std::string::npos) ? "" : s.substr(start, end - start + 1);
}

/// Convert string to lowercase.
std::string toLower(const std::string& s) {
    std::string result = s;
    std::transform(result.begin(), result.end(), result.begin(), ::tolower);
    return result;
}

/// Split a string by a delimiter character.
StringList split(const std::string& s, char delim) {
    StringList tokens;
    std::istringstream stream(s);
    std::string token;
    while (std::getline(stream, token, delim)) {
        tokens.push_back(token);
    }
    return tokens;
}

/// Join a list of strings with a separator.
std::string join(const StringList& parts, const std::string& sep) {
    std::string result;
    for (size_t i = 0; i < parts.size(); ++i) {
        if (i > 0) result += sep;
        result += parts[i];
    }
    return result;
}

namespace Encoding {

/// Base64-encode a byte string.
std::string base64Encode(const std::string& input);

/// Base64-decode a string.
std::string base64Decode(const std::string& encoded);

}  // namespace Encoding

}  // namespace Utils
