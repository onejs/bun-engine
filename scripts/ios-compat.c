#include <libkern/OSCacheControl.h>
void __clear_cache(void *start, void *end) { sys_icache_invalidate(start, (char *)end - (char *)start); }
#include <dlfcn.h>
#include <mach-o/loader.h>
const struct mach_header *_NSGetMachExecuteHeader(void) {
 Dl_info info;
 if (!dladdr(__builtin_return_address(0), &info)) return 0;
 return info.dli_fbase;
}
#if !TARGET_OS_SIMULATOR
void pthread_jit_write_protect_np(int enabled) { (void)enabled; __builtin_trap(); }
#endif
