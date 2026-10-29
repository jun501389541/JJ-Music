#define UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fstream>
#include <filesystem>

// A console-subsystem executable used as a synthetic Node stand-in. Unlike a
// GUI binary it would allocate a console if CREATE_NO_WINDOW were missing.
int wmain(int argc, wchar_t** argv) {
    if (argc != 6) return 2;
    const std::filesystem::path root(argv[5]);
    std::ofstream report(root / L"console.json");
    report << "{\"consoleAttached\":" << (GetConsoleWindow() ? "true" : "false") << "}";
    return 0;
}
