import { useEffect, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * Imported glTF models, loaded from the project file once each. A model is
 * normalised so its base sits at y = 0, centred, 1 unit tall: blueprints then
 * scale it to their real height.
 */
const cache = new Map<string, Promise<THREE.Object3D>>()

function load(assetId: string): Promise<THREE.Object3D> {
  let model = cache.get(assetId)
  if (!model) {
    model = (async () => {
      const result = await window.universe.getAsset(assetId)
      if (!result.ok) throw new Error(result.error)
      const { data } = result.value
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      const gltf = await new GLTFLoader().parseAsync(buffer, '')
      // Some exporters leave out normals; without them everything renders black.
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.isMesh && !mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals()
      })
      const box = new THREE.Box3().setFromObject(gltf.scene)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const unit = new THREE.Group()
      gltf.scene.position.set(-center.x, -box.min.y, -center.z)
      unit.add(gltf.scene)
      unit.scale.setScalar(1 / Math.max(size.y, 1e-6))
      return unit
    })()
    cache.set(assetId, model)
    model.catch(() => cache.delete(assetId))
  }
  return model
}

/** A fresh copy of a model (its own materials, so it can be tinted), or null while loading or if it failed. */
export function useModel(assetId: string): THREE.Object3D | null {
  const [model, setModel] = useState<{ id: string; object: THREE.Object3D } | null>(null)
  useEffect(() => {
    let live = true
    load(assetId).then(
      (source) => {
        if (!live) return
        const object = source.clone(true)
        object.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (mesh.isMesh) mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : mesh.material.clone()
        })
        setModel({ id: assetId, object })
      },
      () => live && setModel(null)
    )
    return () => {
      live = false
    }
  }, [assetId])
  return model?.id === assetId ? model.object : null
}
