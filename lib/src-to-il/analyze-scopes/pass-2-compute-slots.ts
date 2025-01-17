import { unexpected, assertUnreachable, hardAssert, uniqueNameInSet } from "../../utils";
import { visitingNode } from "../common";
import { ModuleScope, GlobalSlot, Binding, Slot, FunctionScope, ClosureSlot, Scope, LocalSlot, SlotAccessInfo } from "./analysis-model";
import { AnalysisState } from "./analysis-state";

export function pass2_computeSlots({
  file,
  cur,
  importedModuleNamespaceSlots,
  importBindings,
  model,
}: AnalysisState) {
  /*
  This function calculates the size of each closure scope, and the index of each
  variable in the closure scope.

  The structure of this implementation is:

      computeModuleSlots
        computeFunctionSlots
          computeBlockLikeSlots

  For the module, `computeModuleSlots` deals with global variables and
  import/exports before deferring to `computeFunctionSlots` which deals with all
  remaining function-level declarations before in turn deferring to
  `computeBlockLikeSlots` for all the lexical declarations (for the module
  scope). `computeBlockLikeSlots` then recurses on the children scopes, which
  may be functions or blocks.
  */

  const { scopes, globalSlots, freeVariables } = model;

  const root = scopes.get(file.program) || unexpected();
  visitingNode(cur, file);
  if (root.type !== 'ModuleScope') unexpected();
  // Recurse the tree starting at the root
  computeModuleSlots(root);

  function computeModuleSlots(moduleScope: ModuleScope) {
    const globalSlotNames = new Set([...freeVariables]);
    const newGlobalSlot = (nameHint: string): GlobalSlot => {
      // Note: the generated names can't conflict with existing module names
      // OR free variable names since we use the same IL instruction to load
      // both.
      const name = uniqueNameInSet(nameHint, globalSlotNames);
      const slot: GlobalSlot = { type: 'GlobalSlot', name };
      globalSlots.push(slot);
      return slot;
    };

    // TODO: It would make a lot of sense if the "thisModule" slot was also just
    // an external linking reference, like with imports
    model.thisModuleSlot = newGlobalSlot('thisModule');

    const getImportedModuleNamespaceSlot = (source: string) => {
      let slot = importedModuleNamespaceSlots.get(source);
      if (!slot) {
        const name = uniqueNameInSet(source, globalSlotNames);
        slot = { type: 'GlobalSlot', name };
        importedModuleNamespaceSlots.set(source, slot);
        model.moduleImports.push({ slot, source });
      }
      return slot;
    };

    // Root-level bindings
    for (const binding of Object.values(moduleScope.bindings)) {
      binding.slot = computeModuleSlot(binding);
    }

    // Compute entry-function slots (this will skip any bindings that already
    // have slots assigned, such as module slots)
    computeFunctionSlots(moduleScope);

    function computeModuleSlot(binding: Binding): Slot | undefined {
      if (importBindings.has(binding)) {
        return computeImportBindingSlot(binding);
      } else if (binding.isExported) {
        return computeExportBindingSlot(binding);
      } else if (binding.isAccessedByNestedFunction) {
        // Note: We only need to allocate a global slot if the variable is
        // accessed by a nested function, otherwise it can just be a local
        // variable in the module entry function
        return newGlobalSlot(binding.name);
      } else {
        // Fall back to normal function variable behavior
        return undefined;
      }
    }

    function computeImportBindingSlot(binding: Binding): Slot {
      const { source, specifier } = importBindings.get(binding) ?? unexpected();
      const moduleNamespaceObjectSlot = getImportedModuleNamespaceSlot(source);

      switch (specifier.type) {
        // import x as y from 'z'
        case 'ImportSpecifier':
          return {
            type: 'ModuleImportExportSlot',
            moduleNamespaceObjectSlot,
            propertyName:
              specifier.imported.type === 'Identifier' ? specifier.imported.name :
              specifier.imported.type === 'StringLiteral' ? specifier.imported.value :
              assertUnreachable(specifier.imported)
          };

        // import * as y from 'z';
        case 'ImportNamespaceSpecifier':
          return moduleNamespaceObjectSlot;

        // import y from 'z';
        case 'ImportDefaultSpecifier':
          return {
            type: 'ModuleImportExportSlot',
            moduleNamespaceObjectSlot,
            propertyName: 'default'
          };

        default: assertUnreachable(specifier);
      }
    }

    function computeExportBindingSlot(binding: Binding): Slot {
      return {
        type: 'ModuleImportExportSlot',
        moduleNamespaceObjectSlot: model.thisModuleSlot,
        propertyName: binding.name
      }
    }
  }

  // Note: this function takes either FunctionScope or ModuleScope because it
  // is also used to compute slots for the entry function. Essentially, we
  // treat the module as a special kind of function that also has module
  // slots.
  function computeFunctionSlots(functionScope: FunctionScope | ModuleScope) {
    let stackDepth = 0;

    const pushLocalSlot = (): LocalSlot => ({ type: 'LocalSlot', index: stackDepth++ });

    const nextClosureSlot = () => {
      functionScope.closureSlots = functionScope.closureSlots ?? [];
      const slot: ClosureSlot = { type: 'ClosureSlot', index: functionScope.closureSlots.length };
      functionScope.closureSlots.push(slot);
      return slot;
    };

    // Parameters
    if (functionScope.type === 'FunctionScope') {
      computeIlFunctionParameterSlots(functionScope, nextClosureSlot, pushLocalSlot);
    }

    // Hoisted var declarations
    for (const binding of functionScope.varDeclarations) {
      // Var declarations at the module level may already have global slots allocated
      if (binding.slot) continue;

      hardAssert(binding.kind === 'var');
      binding.slot = nextFunctionLocalOrClosureSlot(binding);
      if (binding.slot) {
        functionScope.prologue.push({
          type: 'InitVarDeclaration',
          slot: accessSlotForInitialization(binding.slot)
        })
      }
    }

    // Compute slots for nested functions and variables and recurse
    computeBlockLikeSlots(functionScope, nextClosureSlot);

    // Compute slots in a block-like scope (including lexical slots in a
    // function, but not things like parameter slots or `var` declarations which
    // are handled at the function level)
    function computeBlockLikeSlots(
      blockScope: Scope,
      nextClosureSlotInParent: () => ClosureSlot
    ) {
      /*
       * Note: this function actually deals with function scopes as well, since
       * the function body is like a block.
       *
       * Within a block, there are slots for:
       *
       *  - nested function declarations (which are hoisted to the beginning of
       *    the block, not necessarily the beginning of the containing function)
       *  - lexical bindings (let and const)
       */

      const blockStartStackDepth = stackDepth;

      // Nested function declarations
      for (const decl of blockScope.nestedFunctionDeclarations) {
        const { binding, func } = decl;

        // Function declarations at the module level may already have global slots allocated
        if (!binding.slot) {
          binding.slot = nextBlockLocalOrClosureSlot(binding);
        }

        const functionInfo = model.scopes.get(func) ?? unexpected();
        if (functionInfo.type !== 'FunctionScope') unexpected();
        const functionId = functionInfo.ilFunctionId;

        if (binding.slot) {
          blockScope.prologue.push({
            type: 'InitFunctionDeclaration',
            functionId,
            functionIsClosure: functionInfo.functionIsClosure,
            slot: accessSlotForInitialization(binding.slot)
          });
        }
      }

      // Lexical declarations
      for (const binding of blockScope.lexicalDeclarations) {
        // Lexical declarations at the module level may already have global slots allocated
        if (binding.slot) continue;

        binding.slot = nextBlockLocalOrClosureSlot(binding);
        // Note: closure slots are already initialized when the scope is created
        if (binding.slot && binding.slot.type === 'LocalSlot') {
          blockScope.prologue.push({
            type: 'InitLexicalDeclaration',
            slot: accessSlotForInitialization(binding.slot)
          });
        }
      }

      for (const child of blockScope.children) {
        switch (child.type) {
          case 'BlockScope': computeBlockLikeSlots(child, nextClosureSlotInBlockOrParent); break;
          case 'FunctionScope': computeFunctionSlots(child); break;
          case 'ModuleScope': unexpected();
          default: assertUnreachable(child);
        }
      }

      // Now that all the slots have been computed, we know if there are any
      // closure slots that need to be created in the prologue
      if (blockScope.closureSlots) {
        blockScope.prologue.unshift({
          type: 'ScopePush',
          slotCount: blockScope.closureSlots.length
        })
        blockScope.epiloguePopScope = true;
      }

      if (blockScope.type === 'BlockScope') {
        blockScope.epiloguePopCount = stackDepth - blockStartStackDepth;
      }
      stackDepth = blockStartStackDepth;

      function nextBlockLocalOrClosureSlot(binding: Binding): LocalSlot | ClosureSlot {
        hardAssert(!binding.slot);

        if (binding.isAccessedByNestedFunction) {
          return nextClosureSlotInBlockOrParent();
        } else {
          // Note that variables from multiple successive blocks can share the same local slot
          return pushLocalSlot();
        }
      }

      function nextClosureSlotInBlockOrParent(): ClosureSlot {
        // If this is a block with the same lifetime as its parent block or
        // function, we can optimize by storing variables in the parent
        if (blockScope.sameLifetimeAsParent) {
          return nextClosureSlotInParent();
        } else {
          return nextClosureSlotInBlock() ;
        }
      }

      function nextClosureSlotInBlock() {
        blockScope.closureSlots = blockScope.closureSlots ?? [];
        const slot: ClosureSlot = { type: 'ClosureSlot', index: blockScope.closureSlots.length };
        blockScope.closureSlots.push(slot);
        return slot;
      }
    }

    function nextFunctionLocalOrClosureSlot(binding: Binding): LocalSlot | ClosureSlot {
      hardAssert(!binding.slot);

      if (binding.isAccessedByNestedFunction) {
        return nextClosureSlot();
      } else {
        // Note that variables from multiple successive blocks can share the same local slot
        return pushLocalSlot();
      }
    }
  }
}

function computeIlFunctionParameterSlots(
  functionScope: FunctionScope,
  nextClosureSlot: () => ClosureSlot,
  pushLocalSlot: () => LocalSlot
) {
  // Function declarations introduce a new lexical `this` into scope,
  // whereas arrow functions do not (the lexical this falls through to the
  // parent).
  const thisBinding = functionScope.thisBinding;

  if (thisBinding) {
    // The `this` binding is never writtenTo, so it never needs to be copied
    // into a local variable slot. But if it's used by a child (e.g. arrow
    // function) then it needs initialization to copy it from `LoadArg` to
    // `StoreScoped`.
    hardAssert(!thisBinding.isWrittenTo);
    if (thisBinding.isAccessedByNestedFunction) {
      thisBinding.slot = nextClosureSlot();
      functionScope.prologue.push({
        type: 'InitThis',
        slot: accessSlotForInitialization(thisBinding.slot)
      });
    } else {
      // Here, there's no need for initialization
      // (ilParameterInitializations) since it won't be copied into a
      // parameter slot.
      thisBinding.slot = {
        type: 'ArgumentSlot',
        argIndex: 0
      }
    }
  }

  // Compute slots for the named parameters of the function
  for (const [paramI, binding] of functionScope.parameterBindings.entries()) {
    // Note: `LoadArg(0)` always refers to the caller-passed `this` value
    const argIndex = paramI + 1;
    if (binding.isAccessedByNestedFunction) {
      binding.slot = nextClosureSlot();
      functionScope.prologue.push({
        type: 'InitParameter',
        argIndex,
        slot: accessSlotForInitialization(binding.slot)
      })
    } else if (binding.isWrittenTo) {
      // In this case, the binding is writable but not in the closure
      // scope. We need an initializer to copy the initial argument value
      // into the parameter slot
      binding.slot = pushLocalSlot();
      functionScope.prologue.push({
        type: 'InitParameter',
        argIndex,
        slot: binding.slot
      })
    } else {
      // In this case, the parameter is used but never mutated so it can
      // directly use LoadArg. We don't need any new prologue steps
      // because the arguments are already in these slots when the
      // function runs
      binding.slot = { type: 'ArgumentSlot', argIndex };
    }
  }
}

/**
 * Gives an accessor for a slot for the purposes of initializing the slot.
 *
 * Since this function assumes that the purpose is initialization, closure slots
 * give accessors where the relative index is the local index + 1, where the +1
 * comes from the fact that the first variable is accessed at index `1` because
 * the first entry in the scope array is reserved for the parent scope.
 */
function accessSlotForInitialization(slot: Slot): SlotAccessInfo {
  if (slot.type === 'ClosureSlot') {
    return {
      type: 'ClosureSlotAccess',
      relativeIndex: slot.index + 1
    }
  }
  return slot;
}