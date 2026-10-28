#pragma once
#include <string>

// Windows CRT argv quoting. Every argument is quoted; trailing backslashes
// must be doubled before the closing quote, as must slashes before a quote.
inline std::wstring QuoteArgument(const std::wstring& value) {
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (wchar_t ch : value) {
        if (ch == L'\\') { ++slashes; continue; }
        if (ch == L'\"') {
            result.append(slashes * 2 + 1, L'\\');
        } else {
            result.append(slashes, L'\\');
        }
        slashes = 0;
        result.push_back(ch);
    }
    result.append(slashes * 2, L'\\');
    result.push_back(L'\"');
    return result;
}
