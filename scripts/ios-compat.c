// what the iOS SDK lacks for a runtime built against macOS. it links into the app
// executable, which holds the compiled program in __TEXT,__bun
#include <TargetConditionals.h>
#include <libkern/OSCacheControl.h>
#include <mach-o/ldsyms.h>

void __clear_cache(void *start, void *end) { sys_icache_invalidate(start, (char *)end - (char *)start); }

const struct mach_header *_NSGetMachExecuteHeader(void) { return (const struct mach_header *)&_mh_execute_header; }

#if !TARGET_OS_SIMULATOR
void pthread_jit_write_protect_np(int enabled) { (void)enabled; __builtin_trap(); }
#endif
