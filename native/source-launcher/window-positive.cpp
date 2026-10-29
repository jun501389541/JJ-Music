#define UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR command, int) {
    WNDCLASSW cls{};
    cls.lpfnWndProc = DefWindowProcW; cls.hInstance = instance; cls.lpszClassName = L"JJWindowProbePositive";
    if (!RegisterClassW(&cls)) return 1;
    HWND window = CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, cls.lpszClassName, L"Synthetic window observation control",
        WS_OVERLAPPED | WS_CAPTION, 20, 20, 220, 70, nullptr, nullptr, instance, nullptr);
    if (!window) return 2;
    // The first ShowWindow may be overridden by the launcher's STARTUPINFO.
    ShowWindow(window, SW_SHOWNOACTIVATE); ShowWindow(window, SW_SHOWNOACTIVATE);
    const ULONGLONG until = GetTickCount64() + (std::wstring(command) == L"--fast" ? 0 : 600);
    while (GetTickCount64() < until) {
        MSG message{};
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
        Sleep(5);
    }
    DestroyWindow(window);
    return 0;
}
