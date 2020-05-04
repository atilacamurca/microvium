#include "error_descriptions.hh"

std::map<vm_TeError, std::string> errorDescriptions = {
  { VM_E_SUCCESS, "VM_E_SUCCESS" },
  { VM_E_UNEXPECTED, "VM_E_UNEXPECTED" },
  { VM_E_MALLOC_FAIL, "VM_E_MALLOC_FAIL" },
  { VM_E_ALLOCATION_TOO_LARGE, "VM_E_ALLOCATION_TOO_LARGE" },
  { VM_E_INVALID_ADDRESS, "VM_E_INVALID_ADDRESS" },
  { VM_E_COPY_ACROSS_BUCKET_BOUNDARY, "VM_E_COPY_ACROSS_BUCKET_BOUNDARY" },
  { VM_E_FUNCTION_NOT_FOUND, "VM_E_FUNCTION_NOT_FOUND" },
  { VM_E_INVALID_HANDLE, "VM_E_INVALID_HANDLE" },
  { VM_E_STACK_OVERFLOW, "VM_E_STACK_OVERFLOW" },
  { VM_E_UNRESOLVED_IMPORT, "VM_E_UNRESOLVED_IMPORT" },
  { VM_E_ATTEMPT_TO_WRITE_TO_ROM, "VM_E_ATTEMPT_TO_WRITE_TO_ROM" },
  { VM_E_INVALID_ARGUMENTS, "VM_E_INVALID_ARGUMENTS" },
  { VM_E_TYPE_ERROR, "VM_E_TYPE_ERROR" },
  { VM_E_TARGET_NOT_CALLABLE, "VM_E_TARGET_NOT_CALLABLE" },
  { VM_E_HOST_ERROR, "VM_E_HOST_ERROR" },
  { VM_E_NOT_IMPLEMENTED, "VM_E_NOT_IMPLEMENTED" },
  { VM_E_HOST_RETURNED_INVALID_VALUE, "VM_E_HOST_RETURNED_INVALID_VALUE" },
  { VM_E_ASSERTION_FAILED, "VM_E_ASSERTION_FAILED" },
  { VM_E_INVALID_BYTECODE, "VM_E_INVALID_BYTECODE" },
};