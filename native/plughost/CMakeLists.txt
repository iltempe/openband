# openband-plughost (G8): the native plugin host of the desktop app, and its test fixtures.
#   cmake -S native/plughost -B build/plughost -DCMAKE_BUILD_TYPE=Release && cmake --build build/plughost
cmake_minimum_required(VERSION 3.16)
project(openband_plughost C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

set(CLAP_INCLUDE ${CMAKE_CURRENT_SOURCE_DIR}/third_party/clap/include)
# VST3 (G8.5): the SDK's interfaces and hosting helpers (MIT), and the adapter.
set(VST3 ${CMAKE_CURRENT_SOURCE_DIR}/third_party/vst3)
set(VST3_SRC
  src/vst3.cpp
  ${VST3}/pluginterfaces/base/funknown.cpp
  ${VST3}/pluginterfaces/base/coreiids.cpp
  ${VST3}/pluginterfaces/base/ustring.cpp
  ${VST3}/pluginterfaces/base/conststringtable.cpp
  ${VST3}/public.sdk/source/vst/hosting/module.cpp
  ${VST3}/public.sdk/source/vst/hosting/hostclasses.cpp
  ${VST3}/public.sdk/source/vst/hosting/pluginterfacesupport.cpp
  ${VST3}/public.sdk/source/vst/hosting/eventlist.cpp
  ${VST3}/public.sdk/source/vst/hosting/parameterchanges.cpp
  ${VST3}/public.sdk/source/vst/hosting/processdata.cpp
  ${VST3}/public.sdk/source/vst/utility/stringconvert.cpp
  ${VST3}/public.sdk/source/common/commonstringconvert.cpp
  ${VST3}/public.sdk/source/vst/vstinitiids.cpp
  ${VST3}/public.sdk/source/common/commoniids.cpp)
if(APPLE)
  enable_language(OBJCXX)
  list(APPEND VST3_SRC ${VST3}/public.sdk/source/vst/hosting/module_mac.mm)
  set_source_files_properties(${VST3}/public.sdk/source/vst/hosting/module_mac.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
elseif(WIN32)
  list(APPEND VST3_SRC ${VST3}/public.sdk/source/vst/hosting/module_win32.cpp)
else()
  list(APPEND VST3_SRC ${VST3}/public.sdk/source/vst/hosting/module_linux.cpp)
endif()

# The platform layer: Cocoa on macOS, Win32 on Windows, POSIX threads elsewhere.
if(APPLE)
  enable_language(OBJC OBJCXX)
  set(PLATFORM_SRC src/platform_mac.m src/au.mm)
  set_source_files_properties(src/au.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc -std=c++17")
elseif(WIN32)
  set(PLATFORM_SRC src/platform_win.c)
else()
  set(PLATFORM_SRC src/platform_posix.c)
endif()
add_executable(openband-plughost src/plughost.c src/audio_device.c ${PLATFORM_SRC} ${VST3_SRC})
target_include_directories(openband-plughost PRIVATE ${CLAP_INCLUDE} ${VST3} ${CMAKE_CURRENT_SOURCE_DIR}/third_party/miniaudio)
# miniaudio is a single big header: built without warnings.
if(NOT MSVC)
  set_source_files_properties(src/audio_device.c PROPERTIES COMPILE_FLAGS "-w")
endif()
if(APPLE)
  target_link_libraries(openband-plughost PRIVATE "-framework Cocoa" "-framework CoreFoundation" "-framework AudioToolbox" "-framework AudioUnit" "-framework CoreAudioKit" "-framework CoreAudio" "-framework CoreMIDI")
  set_source_files_properties(src/platform_mac.m PROPERTIES COMPILE_FLAGS "-fobjc-arc")
elseif(WIN32)
  target_link_libraries(openband-plughost PRIVATE user32 ole32)
  target_compile_definitions(openband-plughost PRIVATE _UNICODE UNICODE)
else()
  find_package(Threads REQUIRED)
  target_link_libraries(openband-plughost PRIVATE dl Threads::Threads stdc++fs m)
endif()
if(MSVC)
  target_compile_options(openband-plughost PRIVATE /W3)
else()
  target_compile_options(openband-plughost PRIVATE -Wall -Wextra -O2)
endif()

option(OPENBAND_FIXTURES "Build the test fixture plugins (never shipped)" ON)
if(OPENBAND_FIXTURES)
  foreach(name ob-fixtures ob-hang)
    add_library(${name} MODULE test/fixtures.c)
    target_include_directories(${name} PRIVATE ${CLAP_INCLUDE})
    if(name STREQUAL "ob-hang")
      target_compile_definitions(${name} PRIVATE OB_HANG)
    endif()
    if(UNIX AND NOT APPLE)
      target_link_libraries(${name} PRIVATE m)
    endif()
    set_target_properties(${name} PROPERTIES PREFIX "" SUFFIX ".clap")
    if(APPLE)
      set_target_properties(${name} PROPERTIES BUNDLE TRUE BUNDLE_EXTENSION clap MACOSX_BUNDLE_BUNDLE_NAME ${name})
    endif()
  endforeach()

  # The VST3 test plugins (G8.5), with the SDK's plugin classes, in a .vst3 bundle.
  file(GLOB VST3_BASE ${VST3}/base/source/*.cpp ${VST3}/base/thread/source/*.cpp)
  add_library(ob-vst3-fixtures MODULE test/vst3fixtures.cpp ${VST3_BASE}
    ${VST3}/pluginterfaces/base/funknown.cpp ${VST3}/pluginterfaces/base/coreiids.cpp
    ${VST3}/pluginterfaces/base/ustring.cpp ${VST3}/pluginterfaces/base/conststringtable.cpp
    ${VST3}/public.sdk/source/vst/vstaudioeffect.cpp ${VST3}/public.sdk/source/vst/vstcomponent.cpp
    ${VST3}/public.sdk/source/vst/vstcomponentbase.cpp ${VST3}/public.sdk/source/vst/vsteditcontroller.cpp
    ${VST3}/public.sdk/source/vst/vstparameters.cpp ${VST3}/public.sdk/source/vst/vstbus.cpp
    ${VST3}/public.sdk/source/vst/vstinitiids.cpp ${VST3}/public.sdk/source/common/commoniids.cpp
    ${VST3}/public.sdk/source/common/pluginview.cpp
    ${VST3}/public.sdk/source/main/pluginfactory.cpp ${VST3}/public.sdk/source/main/moduleinit.cpp)
  target_include_directories(ob-vst3-fixtures PRIVATE ${VST3})
  target_compile_definitions(ob-vst3-fixtures PRIVATE RELEASE=1 _USE_MATH_DEFINES)
  set_target_properties(ob-vst3-fixtures PROPERTIES PREFIX "" CXX_STANDARD 17 CXX_VISIBILITY_PRESET hidden)
  if(APPLE)
    target_sources(ob-vst3-fixtures PRIVATE ${VST3}/public.sdk/source/main/macmain.cpp)
    target_link_libraries(ob-vst3-fixtures PRIVATE "-framework CoreFoundation")
    set_target_properties(ob-vst3-fixtures PROPERTIES BUNDLE TRUE BUNDLE_EXTENSION vst3 MACOSX_BUNDLE_BUNDLE_NAME ob-vst3-fixtures)
  else()
    # Windows and Linux: ob-vst3-fixtures.vst3/Contents/<arch>-<os>/ob-vst3-fixtures.<vst3|so>
    if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(AMD64|x86_64|x64)$")
      set(VST3_ARCH x86_64)
    elseif(WIN32)
      set(VST3_ARCH arm64)
    else()
      set(VST3_ARCH aarch64)
    endif()
    if(WIN32)
      target_sources(ob-vst3-fixtures PRIVATE ${VST3}/public.sdk/source/main/dllmain.cpp)
      set(VST3_DIR ${VST3_ARCH}-win)
      set_target_properties(ob-vst3-fixtures PROPERTIES SUFFIX ".vst3")
    else()
      target_sources(ob-vst3-fixtures PRIVATE ${VST3}/public.sdk/source/main/linuxmain.cpp)
      target_link_libraries(ob-vst3-fixtures PRIVATE Threads::Threads dl)
      set(VST3_DIR ${VST3_ARCH}-linux)
    endif()
    set_target_properties(ob-vst3-fixtures PROPERTIES LIBRARY_OUTPUT_DIRECTORY $<1:${CMAKE_BINARY_DIR}/ob-vst3-fixtures.vst3/Contents/${VST3_DIR}>)
  endif()
endif()
