// Test fixture only: hold an outer Job while the Node verifier tests inner Jobs.
#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <string>
#include <vector>
#include "argv.h"

struct Handle {
    HANDLE value = nullptr;
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
struct Attributes {
    std::vector<BYTE> bytes;
    LPPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
    ~Attributes() { if (value) DeleteProcThreadAttributeList(value); }
};
int wmain(int argc, wchar_t** argv) {
    const bool limited = argc > 1 && std::wstring(argv[1]) == L"--limit-three";
    const int first = limited ? 2 : 1;
    if (argc < first + 2) return 2;
    Handle job, process, thread;
    job.value = CreateJobObjectW(nullptr, nullptr);
    if (!job.value) return 3;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (limited) {
        // Exactly supervisor + owner + helper; a fourth (host) must be refused.
        limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.BasicLimitInformation.ActiveProcessLimit = 3;
    }
    if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 4;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION actual{};
    if (!QueryInformationJobObject(job.value, JobObjectExtendedLimitInformation, &actual, sizeof(actual), nullptr)) return 12;
    if (limited && (!(actual.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_ACTIVE_PROCESS)
        || actual.BasicLimitInformation.ActiveProcessLimit != 3)) return 13;
    Attributes attrs;
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
    attrs.bytes.resize(size);
    auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attrs.bytes.data());
    if (!InitializeProcThreadAttributeList(list, 1, 0, &size)) return 5;
    attrs.value = list;
    if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job.value, sizeof(job.value), nullptr, nullptr)) return 6;
    std::wstring command;
    for (int i = first; i < argc; ++i) {
        if (i > first) command += L' ';
        command += QuoteArgument(argv[i]);
    }
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    startup.lpAttributeList = list;
    PROCESS_INFORMATION info{};
    if (!CreateProcessW(argv[first], command.data(), nullptr, nullptr, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
        nullptr, nullptr, &startup.StartupInfo, &info)) return 7;
    process.value = info.hProcess;
    thread.value = info.hThread;
    BOOL member = FALSE;
    if (!IsProcessInJob(process.value, job.value, &member) || !member) return 8;
    std::puts("OUTER_JOB_CONFIRMED");
    if (limited) std::puts("OUTER_JOB_LIMIT_CONFIRMED");
    std::fflush(stdout);
    if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) return 9;
    if (WaitForSingleObject(process.value, 25000) != WAIT_OBJECT_0) return 10;
    DWORD code = 0;
    if (!GetExitCodeProcess(process.value, &code)) return 11;
    // Never let closing the outer Job turn a leaked suspended host into a pass.
    const ULONGLONG deadline = GetTickCount64() + 5000;
    for (;;) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
        if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation,
            &accounting, sizeof(accounting), nullptr)) return 14;
        if (!accounting.ActiveProcesses) break;
        if (GetTickCount64() >= deadline) return 15;
        Sleep(10);
    }
    std::puts("OUTER_JOB_EMPTY");
    return static_cast<int>(code);
}
