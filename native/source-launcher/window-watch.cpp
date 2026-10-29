#define UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <map>
#include <string>
#include <vector>

struct Observation { DWORD pid, event; std::string cls; bool visible, topLevel; };
DWORD rootPid = 0;
std::vector<Observation> observations;
bool overflow = false;
unsigned snapshotFailures = 0;
unsigned unresolvedWindows = 0;
unsigned unresolvedAncestry = 0;

bool Descendant(DWORD pid) {
    if (!pid || pid == GetCurrentProcessId()) return false;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) { ++snapshotFailures; return false; }
    PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
    std::map<DWORD, DWORD> parents;
    if (Process32FirstW(snapshot, &entry)) do {
        parents[entry.th32ProcessID] = entry.th32ParentProcessID;
    } while (Process32NextW(snapshot, &entry));
    else ++snapshotFailures;
    CloseHandle(snapshot);
    for (unsigned i = 0; i < 64 && pid; ++i) {
        if (pid == rootPid) return true;
        if (pid == 4) return false;
        auto parent = parents.find(pid);
        if (parent == parents.end() || parent->second == pid) { ++unresolvedAncestry; return false; }
        pid = parent->second;
    }
    if (pid) ++unresolvedAncestry;
    return false;
}
void CALLBACK Observe(HWINEVENTHOOK, DWORD event, HWND window, LONG object, LONG child, DWORD, DWORD) {
    if (!window || object != OBJID_WINDOW || child != CHILDID_SELF || event == EVENT_OBJECT_DESTROY) return;
    DWORD pid = 0;
    if (!GetWindowThreadProcessId(window, &pid)) { ++unresolvedWindows; return; }
    if (!Descendant(pid)) return;
    char name[128]{};
    GetClassNameA(window, name, 128);
    std::string cls(name);
    for (char& c : cls) if (static_cast<unsigned char>(c) < 32 || static_cast<unsigned char>(c) > 126) c = '?';
    if (observations.size() >= 1024) { overflow = true; return; }
    observations.push_back({pid, event, cls, IsWindowVisible(window) != FALSE, GetAncestor(window, GA_ROOT) == window});
}
int wmain(int argc, wchar_t** argv) {
    if (argc != 5) return 2;
    wchar_t* end = nullptr;
    unsigned long long parsed = wcstoull(argv[1], &end, 10);
    if (!end || *end || !parsed || parsed > MAXDWORD) return 2;
    rootPid = static_cast<DWORD>(parsed);
    auto windows = SetWinEventHook(EVENT_OBJECT_CREATE, EVENT_OBJECT_SHOW, nullptr, Observe, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    auto foreground = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr, Observe, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    if (!windows || !foreground) {
        if (windows) UnhookWinEvent(windows);
        if (foreground) UnhookWinEvent(foreground);
        return 3;
    }
    { std::ofstream ready{std::filesystem::path(argv[2])}; ready << "ready"; }
    const ULONGLONG deadline = GetTickCount64() + 60000;
    bool timedOut = false;
    while (!std::filesystem::exists(argv[3])) {
        MSG message{};
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&message); DispatchMessageW(&message);
        }
        if (GetTickCount64() >= deadline) { timedOut = true; break; }
        Sleep(5);
    }
    // Drain already queued callbacks before unhooking.
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
    UnhookWinEvent(windows); UnhookWinEvent(foreground);
    std::ofstream report{std::filesystem::path(argv[4])};
    report << "{\"schema\":1,\"timedOut\":" << (timedOut ? "true" : "false")
        << ",\"overflow\":" << (overflow ? "true" : "false") << ",\"snapshotFailures\":" << snapshotFailures
        << ",\"unresolvedWindows\":" << unresolvedWindows << ",\"unresolvedAncestry\":" << unresolvedAncestry << ",\"records\":[";
    bool first = true;
    for (const auto& row : observations) {
        if (!first) report << ',';
        first = false;
        report << "{\"pid\":" << row.pid << ",\"event\":" << row.event << ",\"class\":" << std::quoted(row.cls)
            << ",\"visible\":" << (row.visible ? "true" : "false") << ",\"topLevel\":" << (row.topLevel ? "true" : "false") << '}';
    }
    report << "]}";
    return report.good() && !timedOut && !overflow && !snapshotFailures ? 0 : 4;
}
