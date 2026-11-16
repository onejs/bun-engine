#ifndef BUN_EMBED_H
#define BUN_EMBED_H
#include <JavaScriptCore/JavaScript.h>
#ifdef __cplusplus
extern "C" {
#endif
JSGlobalContextRef bun_embed_create(int argc, const char* const* argv);
int bun_embed_run_entry(JSValueRef* exception);
void bun_embed_tick(void);
/* host callbacks reenter the vm before allocating through the typed-array api. */
void bun_embed_lock(JSContextRef context);
void bun_embed_unlock(JSContextRef context);
/* darwin: register on the main js thread; callback runs there and schedules a tick.
   notifications coalesce until tick. null unregisters before returning. */
void bun_embed_set_wakeup(void (*callback)(void*), void* user);
/* milliseconds until the next timer, zero for ready tasks, nan when idle.
   query on the js thread; it neither fires timers nor invokes javascript. */
double bun_embed_next_timeout(void);
#ifdef __cplusplus
}
#endif
#endif
