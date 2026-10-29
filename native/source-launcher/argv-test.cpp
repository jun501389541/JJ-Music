#include "argv.h"
#include <cassert>

int main() {
    assert(QuoteArgument(L"") == L"\"\"");
    assert(QuoteArgument(L"中文 & (music)") == L"\"中文 & (music)\"");
    assert(QuoteArgument(L"C:\\music\\") == L"\"C:\\music\\\\\"");
    assert(QuoteArgument(L"a\"b") == L"\"a\\\"b\"");
    assert(QuoteArgument(L"a\\\"b") == L"\"a\\\\\\\"b\"");
    return 0;
}
