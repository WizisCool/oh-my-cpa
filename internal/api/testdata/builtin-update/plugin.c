/* Synthetic CPA ABI fixture. No OAuth, credentials, model execution or public routes. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
typedef struct { void *ptr; size_t len; } buffer;
typedef struct { uint32_t abi_version; void *host_ctx; void *call; void *free_buffer; } host_api;
typedef struct { uint32_t abi_version; int (*call)(char*,uint8_t*,size_t,buffer*); void (*free_buffer)(void*,size_t); void (*shutdown)(void); } plugin_api;
static void free_buffer(void *ptr, size_t len) { (void)len; free(ptr); }
static void shutdown_plugin(void) {}
static int call(char *method, uint8_t *request, size_t length, buffer *response) {
    (void)request; (void)length;
    const char *result = "{\"ok\":true,\"result\":{}}";
    if (!strcmp(method,"plugin.register") || !strcmp(method,"plugin.reconfigure"))
        result = "{\"ok\":true,\"result\":{\"schema_version\":6,\"metadata\":{\"name\":\"Synthetic builtin update fixture\",\"version\":\"" FIXTURE_VERSION "\",\"author\":\"Synthetic fixture only\",\"GitHubRepository\":\"https://github.com/example/omc-zcode-oauth\"},\"capabilities\":{\"management_api\":true}}}";
    else if (!strcmp(method,"management.register"))
        result = "{\"ok\":true,\"result\":{\"routes\":[],\"resources\":[]}}";
    response->len = strlen(result);
    response->ptr = malloc(response->len);
    if (!response->ptr) return 1;
    memcpy(response->ptr,result,response->len);
    return 0;
}
int cliproxy_plugin_init(const host_api *host, plugin_api *plugin) {
    if (!host || !plugin || host->abi_version != 1) return 1;
    plugin->abi_version=1; plugin->call=call; plugin->free_buffer=free_buffer; plugin->shutdown=shutdown_plugin;
    return 0;
}
